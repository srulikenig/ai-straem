import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['AUTH_SECRET'] ??= 'x';
process.env['MODE'] = 'echo';
const { parseTurns } = await import('../src/agent/transcribe.js');

test('well-formed turns are kept, trimmed, and empty ones dropped', () => {
  assert.deepEqual(
    parseTurns(JSON.stringify([
      { role: 'bot', text: ' שלום ' },
      { role: 'caller', text: 'שיחזרו אליי.' },
      { role: 'caller', text: '  ' },
    ])),
    [
      { role: 'bot', text: 'שלום' },
      { role: 'caller', text: 'שיחזרו אליי.' },
    ],
  );
});

test('anything else means "keep the live transcript"', () => {
  assert.equal(parseTurns(undefined), null);
  assert.equal(parseTurns('not json'), null);
  assert.equal(parseTurns('[]'), null);
  assert.equal(parseTurns(JSON.stringify([{ role: 'narrator', text: 'x' }])), null);
  assert.equal(parseTurns(JSON.stringify({ role: 'bot', text: 'x' })), null);
});
