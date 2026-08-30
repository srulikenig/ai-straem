import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFinalCommand, parseInbound, transferExtensionCommand } from '../src/pbx/protocol.js';

test('reads a start message under any of the plausible field names', () => {
  const a = parseInbound('{"type":"start","call_id":"abc","caller":"0501234567","extension":"/8"}');
  assert.equal(a?.type, 'start');
  assert.equal(a.type === 'start' && a.callId, 'abc');
  assert.equal(a.type === 'start' && a.caller, '0501234567');

  const b = parseInbound('{"type":"start","callId":"xyz","from":"0521111111","to":"/3"}');
  assert.equal(b?.type === 'start' && b.callId, 'xyz');
  assert.equal(b?.type === 'start' && b.caller, '0521111111');
  assert.equal(b?.type === 'start' && b.extension, '/3');
});

test('keeps the raw payload so unknown fields are still discoverable', () => {
  const msg = parseInbound('{"type":"start","weird_field":42}');
  assert.equal(msg?.raw['weird_field'], 42);
});

test('numeric fields survive as strings', () => {
  const msg = parseInbound('{"type":"dtmf","digit":5}');
  assert.equal(msg?.type === 'dtmf' && msg.digit, '5');
});

test('an unrecognised type is reported rather than dropped', () => {
  assert.equal(parseInbound('{"type":"something_new"}')?.type, 'unknown');
});

test('malformed json yields null instead of throwing', () => {
  assert.equal(parseInbound('not json'), null);
  assert.equal(parseInbound('"a string"'), null);
});

test('only transfer and hangup count as final', () => {
  assert.ok(isFinalCommand(transferExtensionCommand('/2')));
  assert.ok(isFinalCommand({ type: 'hangup' }));
  assert.ok(!isFinalCommand({ type: 'clear' }));
  assert.ok(!isFinalCommand({ type: 'save_answer', name: 'a', value: 'b' }));
});
