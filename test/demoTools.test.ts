import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoTools } from '../src/tools/demo.js';
import { ToolRegistry, type ToolContext } from '../src/tools/registry.js';
import { logger } from '../src/logger.js';
import { expectError, expectOk } from './helpers.js';

const saved: string[] = [];
const ctx: ToolContext = {
  callId: 'test',
  caller: '0521234567',
  call: {
    saveAnswer: (n, v) => saved.push(`${n}=${v}`),
    transferExtension: () => {},
    transferPhone: () => {},
    endCall: () => {},
    get closing() {
      return false;
    },
  },
  log: logger.child({ test: true }),
};

const registry = new ToolRegistry(6000).registerAll(demoTools);

test('order status is deterministic for the same id', async () => {
  const a = await registry.execute('get_order_status', { order_id: 'A-1234' }, ctx);
  const b = await registry.execute('get_order_status', { order_id: 'A-1234' }, ctx);
  assert.equal(a.status, 'ok');
  assert.deepEqual(a, b);
});

test('balance falls back to the number the caller is calling from', async () => {
  const r = expectOk(await registry.execute('check_balance', {}, ctx));
  assert.equal(r['phone_number'], '0521234567');
  assert.equal(r['used_caller_id'], true);
});

test('an invalid phone number is rejected before the handler runs', async () => {
  const r = await registry.execute('check_balance', { phone_number: 'not-a-number' }, ctx);
  assert.equal(expectError(r).error, 'invalid_arguments');
});

test('a missing branch answers with the cities that do exist', async () => {
  const r = expectOk(await registry.execute('find_branch', { city: 'אילת' }, ctx));
  assert.equal(r['found'], false);
  assert.ok(Array.isArray(r['nearest_cities']));
});

test('slow_lookup exceeding the timeout is reported, not hung', async () => {
  const r = await registry.execute('slow_lookup', { seconds: 10 }, ctx);
  assert.equal(expectError(r).error, 'timeout');
});

test('current time comes back in the Israel timezone', async () => {
  const r = expectOk(await registry.execute('get_current_time', {}, ctx));
  assert.equal(r['timezone'], 'Asia/Jerusalem');
  assert.match(String(r['time']), /^\d{2}:\d{2}$/);
});
