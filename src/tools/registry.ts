import type { FunctionDeclaration, Schema } from '@google/genai';
import type { ZodType } from 'zod';
import type { Logger } from '../logger.js';
import type { CallActions } from '../pbx/session.js';

export interface ToolContext {
  callId: string;
  /** The caller's number, when the PBX sent one — handy as a default argument. */
  caller: string | null;
  call: CallActions;
  log: Logger;
}

export interface ToolDefinition<T = unknown> {
  name: string;
  /** Written for the model: say when to call it, not how it is implemented. */
  description: string;
  /** Declared to the model (OpenAPI subset). */
  parameters: Schema;
  /** Enforced at runtime — model-produced arguments are never trusted. */
  input: ZodType<T>;
  /** On a phone call, an unbounded tool is a dropped call. */
  timeoutMs?: number;
  handler: (args: T, ctx: ToolContext) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

/**
 * What the model receives back. Always an object, always resolved.
 *
 * The handler's own payload is nested under `result` rather than spread into
 * the envelope: a tool that legitimately returns its own `status` field (an
 * order status, say) would otherwise overwrite the envelope's and report
 * success or failure it never meant.
 */
export type ToolResult =
  | { status: 'ok'; result: Record<string, unknown> }
  | { status: 'error'; error: string; [key: string]: unknown };

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<never>>();

  constructor(private readonly defaultTimeoutMs: number) {}

  register<T>(def: ToolDefinition<T>): this {
    if (this.tools.has(def.name)) throw new Error(`duplicate tool: ${def.name}`);
    this.tools.set(def.name, def as unknown as ToolDefinition<never>);
    return this;
  }

  registerAll(defs: ToolDefinition<never>[]): this {
    for (const d of defs) this.register(d);
    return this;
  }

  get names(): string[] {
    return [...this.tools.keys()];
  }

  functionDeclarations(): FunctionDeclaration[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * Run one tool. Never throws: a validation failure, a timeout or a thrown
   * handler all come back as a structured error the model can read out loud.
   * Leaving a function call unanswered would stall the conversation.
   */
  async execute(name: string, rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      ctx.log.warn({ tool: name }, 'model called an unknown tool');
      return { status: 'error', error: 'unknown_tool', message: `אין כלי בשם ${name}` };
    }

    const parsed = tool.input.safeParse(rawArgs);
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      ctx.log.warn({ tool: name, rawArgs, details }, 'tool arguments failed validation');
      return { status: 'error', error: 'invalid_arguments', details };
    }

    const timeoutMs = tool.timeoutMs ?? this.defaultTimeoutMs;
    const startedAt = Date.now();
    try {
      const result = await withTimeout(
        Promise.resolve(tool.handler(parsed.data as never, ctx)),
        timeoutMs,
      );
      // The result is logged, not just the arguments: verifying that a tool was
      // really the source of a number the caller heard needs both sides.
      ctx.log.info(
        { tool: name, ms: Date.now() - startedAt, args: parsed.data, result },
        'tool ok',
      );
      return { status: 'ok', result };
    } catch (err) {
      const timedOut = err instanceof TimeoutError;
      ctx.log.error({ tool: name, ms: Date.now() - startedAt, err }, timedOut ? 'tool timed out' : 'tool threw');
      return timedOut
        ? { status: 'error', error: 'timeout', message: `הפעולה לא הסתיימה תוך ${timeoutMs} מילישניות` }
        : { status: 'error', error: 'tool_failed', message: err instanceof Error ? err.message : String(err) };
    }
  }
}

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
