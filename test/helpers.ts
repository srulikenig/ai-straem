import assert from 'node:assert/strict';
import type { ToolResult } from '../src/tools/registry.js';

/** Narrows a tool result to its error branch, failing the test if it succeeded. */
export function expectError(result: ToolResult): { error: string; [key: string]: unknown } {
  assert.equal(result.status, 'error', `expected an error, got ${JSON.stringify(result)}`);
  return result as { status: 'error'; error: string; [key: string]: unknown };
}

/** Narrows a tool result to its payload, failing the test if it errored. */
export function expectOk(result: ToolResult): Record<string, unknown> {
  assert.equal(result.status, 'ok', `expected success, got ${JSON.stringify(result)}`);
  return (result as { status: 'ok'; result: Record<string, unknown> }).result;
}
