import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExpression, ExpressionError, formatForSpeech, normalizeExpression } from '../src/tools/expression.js';

const value = (s: string): number => evaluateExpression(s).value;

test('basic arithmetic', () => {
  assert.equal(value('2+3'), 5);
  assert.equal(value('10-4'), 6);
  assert.equal(value('6*7'), 42);
  assert.equal(value('20/4'), 5);
});

test('operator precedence and parentheses', () => {
  assert.equal(value('2+3*4'), 14);
  assert.equal(value('(2+3)*4'), 20);
  assert.equal(value('(90+60)/2'), 75);
  assert.equal(value('2+3*4-6/3'), 12);
});

test('exponentiation is right associative', () => {
  assert.equal(value('2^3'), 8);
  assert.equal(value('2^3^2'), 512); // 2^(3^2), not (2^3)^2
  assert.equal(value('2^-1'), 0.5);
});

test('unary signs', () => {
  assert.equal(value('-5'), -5);
  assert.equal(value('-5+3'), -2);
  assert.equal(value('10*-2'), -20);
  assert.equal(value('--3'), 3);
});

test('decimals, including the VAT case this exists for', () => {
  assert.equal(value('1250*1.18'), 1475);
  assert.equal(value('0.5+0.25'), 0.75);
  assert.equal(value('.5*4'), 2);
});

test('normalises what speech-to-text actually produces', () => {
  assert.equal(normalizeExpression('1,250 × 1.18'), '1250 * 1.18');
  assert.equal(value('1,250 × 1.18'), 1475);
  assert.equal(value('100 ÷ 4'), 25);
  assert.equal(value('10 − 3'), 7); // unicode minus
});

test('division by zero is an error, not Infinity', () => {
  assert.throws(() => value('5/0'), ExpressionError);
  assert.throws(() => value('5/(3-3)'), ExpressionError);
});

test('percent is rejected with a usable hint instead of guessed at', () => {
  // % could mean modulo or percentage; silently picking one would produce
  // confidently wrong numbers on a phone call.
  try {
    value('18%');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ExpressionError);
    assert.match(err.hint ?? '', /1250\*0\.18/);
  }
});

test('rejects anything that is not arithmetic', () => {
  // The input is a string a model built from a stranger's speech.
  for (const bad of [
    'process.exit(1)',
    'require("fs")',
    '1+1; console.log(1)',
    'alert(1)',
    '__proto__',
    '2+',
    '(2+3',
    '2 3',
    '',
    '   ',
  ]) {
    assert.throws(() => value(bad), ExpressionError, `expected "${bad}" to be rejected`);
  }
});

test('refuses an absurdly long expression', () => {
  assert.throws(() => value('1+'.repeat(200) + '1'), ExpressionError);
});

test('overflow is reported rather than returning Infinity', () => {
  assert.throws(() => value('9^9^9'), ExpressionError);
});

test('speech formatting avoids exponents and float noise', () => {
  assert.equal(formatForSpeech(1475), '1475');
  assert.equal(formatForSpeech(0.1 + 0.2), '0.3');
  assert.equal(formatForSpeech(1 / 3, 2), '0.33');
  assert.equal(formatForSpeech(2.5, 0), '3');
});
