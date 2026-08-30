import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@google/genai';
import { z } from 'zod';
import { ToolRegistry, type ToolContext, type ToolDefinition } from '../src/tools/registry.js';
import { logger } from '../src/logger.js';
import { expectError } from './helpers.js';

const calls: string[] = [];
const ctx: ToolContext = {
  callId: 'test',
  caller: '0501234567',
  call: {
    saveAnswer: (n, v) => calls.push(`save:${n}=${v}`),
    transferExtension: (t) => calls.push(`transfer:${t}`),
    transferPhone: (t) => calls.push(`phone:${t}`),
    endCall: () => calls.push('hangup'),
    get closing() {
      return false;
    },
  },
  log: logger.child({ test: true }),
};

function registry(): ToolRegistry {
  const echo: ToolDefinition<{ value: string }> = {
    name: 'echo',
    description: 'echo',
    parameters: { type: Type.OBJECT, properties: { value: { type: Type.STRING } }, required: ['value'] },
    input: z.object({ value: z.string().min(1) }),
    handler: (args) => ({ echoed: args.value }),
  };
  const slow: ToolDefinition<Record<string, never>> = {
    name: 'slow',
    description: 'slow',
    parameters: { type: Type.OBJECT, properties: {} },
    input: z.object({}),
    timeoutMs: 50,
    handler: async () => {
      await new Promise((r) => setTimeout(r, 500));
      return { never: true };
    },
  };
  const boom: ToolDefinition<Record<string, never>> = {
    name: 'boom',
    description: 'throws',
    parameters: { type: Type.OBJECT, properties: {} },
    input: z.object({}),
    handler: () => {
      throw new Error('kaboom');
    },
  };
  return new ToolRegistry(1000).register(echo).register(slow).register(boom);
}

test('a good call returns ok plus the handler payload', async () => {
  const r = await registry().execute('echo', { value: 'hi' }, ctx);
  assert.deepEqual(r, { status: 'ok', result: { echoed: 'hi' } });
});

test('model-supplied arguments are validated, not trusted', async () => {
  const r = await registry().execute('echo', { value: 42 }, ctx);
  assert.equal(expectError(r).error, 'invalid_arguments');
});

test('a slow tool times out instead of stalling the call', async () => {
  const started = Date.now();
  const r = await registry().execute('slow', {}, ctx);
  assert.equal(expectError(r).error, 'timeout');
  assert.ok(Date.now() - started < 400, 'returned well before the handler finished');
});

test('a throwing handler becomes a structured error', async () => {
  const r = await registry().execute('boom', {}, ctx);
  assert.equal(expectError(r).error, 'tool_failed');
  assert.equal(expectError(r)['message'], 'kaboom');
});

test('an unknown tool name is answered, never left hanging', async () => {
  const r = await registry().execute('nope', {}, ctx);
  assert.equal(expectError(r).error, 'unknown_tool');
});

test("a tool's own 'status' field cannot overwrite the envelope", async () => {
  const statusy: ToolDefinition<Record<string, never>> = {
    name: 'statusy',
    description: 'returns its own status field',
    parameters: { type: Type.OBJECT, properties: {} },
    input: z.object({}),
    handler: () => ({ status: 'delayed', error: 'none' }),
  };
  const r = await new ToolRegistry(1000).register(statusy).execute('statusy', {}, ctx);
  assert.equal(r.status, 'ok', 'envelope still reports success');
  assert.equal(r.status === 'ok' && r.result['status'], 'delayed', 'payload keeps its own field');
});

test('declarations carry over to the model unchanged', () => {
  const decls = registry().functionDeclarations();
  assert.deepEqual(decls.map((d) => d.name).sort(), ['boom', 'echo', 'slow']);
});
