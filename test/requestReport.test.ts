import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReport, hasRequest, type RequestReport } from '../src/agent/requestReport.js';

function report(over: Partial<RequestReport> = {}): RequestReport {
  return {
    caller: '0521234567',
    callId: 'c1',
    startedAt: new Date('2026-10-23T07:00:00Z'),
    durationMs: 95_000,
    answers: {},
    transcript: [],
    recording: null,
    ...over,
  };
}

test('known fields come first, in reading order, with Hebrew labels', () => {
  const text = formatReport(
    report({
      answers: { note: 'x', request: 'לתאם פגישה', caller_name: 'שלמה' },
      transcript: [
        { role: 'bot', text: 'שלום' },
        { role: 'caller', text: ' אני רוצה פגישה ' },
      ],
    }),
  );
  assert.match(text, /פנייה חדשה מ-0521234567/);
  assert.match(text, /1:35 דקות/);
  assert.ok(text.indexOf('שם: שלמה') < text.indexOf('הפנייה: לתאם פגישה'));
  assert.ok(text.indexOf('הפנייה: לתאם פגישה') < text.indexOf('note: x'));
  assert.match(text, /מתקשר: אני רוצה פגישה$/m);
});

test('a call with nothing saved still points at the transcript', () => {
  assert.match(formatReport(report()), /הבוט לא שמר פרטים/);
});

test('a silent call with nothing saved is not a request', () => {
  assert.equal(hasRequest(report({ transcript: [{ role: 'bot', text: 'שלום' }] })), false);
  assert.equal(hasRequest(report({ transcript: [{ role: 'caller', text: 'היי' }] })), true);
  assert.equal(hasRequest(report({ answers: { request: 'x' } })), true);
});
