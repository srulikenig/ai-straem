import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resampler } from '../src/audio/resample.js';

function tone(freq: number, rate: number, seconds: number): Float32Array {
  const n = Math.round(rate * seconds);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / rate);
  return a;
}

function rms(a: Float32Array): number {
  let s = 0;
  for (const v of a) s += v * v;
  return Math.sqrt(s / a.length);
}

test('produces the right number of samples for each direction', () => {
  const up = new Resampler(8000, 16000);
  assert.equal(up.L, 2);
  assert.equal(up.M, 1);
  assert.equal(up.process(tone(1000, 8000, 1)).length, 16000);

  const down = new Resampler(24000, 8000);
  assert.equal(down.L, 1);
  assert.equal(down.M, 3);
  assert.equal(down.process(tone(1000, 24000, 1)).length, 8000);
});

test('preserves the level of an in-band tone', () => {
  for (const [inRate, outRate] of [[8000, 16000], [24000, 8000]] as const) {
    const src = tone(1000, inRate, 1);
    const out = new Resampler(inRate, outRate).process(src);
    const ratio = rms(out) / rms(src);
    assert.ok(ratio > 0.97 && ratio < 1.03, `${inRate}->${outRate} level ratio ${ratio}`);
  }
});

test('rejects out-of-band energy instead of aliasing it back in', () => {
  // 6 kHz at 24 kHz would fold to 2 kHz if we simply dropped samples.
  const out = new Resampler(24000, 8000).process(tone(6000, 24000, 1));
  const attenuationDb = 20 * Math.log10(rms(out) / 0.3536);
  assert.ok(attenuationDb < -40, `expected < -40 dB, got ${attenuationDb.toFixed(1)} dB`);
});

test('streaming in frames matches one-shot exactly', () => {
  const src = tone(700, 24000, 0.5);
  const oneShot = new Resampler(24000, 8000).process(src);

  const streaming = new Resampler(24000, 8000);
  const parts: Float32Array[] = [];
  for (let p = 0; p < src.length; p += 480) parts.push(streaming.process(src.subarray(p, p + 480)));
  const joined = new Float32Array(parts.reduce((n, x) => n + x.length, 0));
  let off = 0;
  for (const part of parts) {
    joined.set(part, off);
    off += part.length;
  }

  assert.equal(joined.length, oneShot.length);
  for (let i = 0; i < joined.length; i++) {
    assert.ok(Math.abs(joined[i]! - oneShot[i]!) < 1e-9, `sample ${i} differs`);
  }
});

test('handles chunk sizes that are not a multiple of the decimation factor', () => {
  const src = tone(700, 24000, 0.3);
  const r = new Resampler(24000, 8000);
  let total = 0;
  for (let p = 0; p < src.length; p += 1000) total += r.process(src.subarray(p, p + 1000)).length;
  assert.equal(total, Math.round(src.length / 3));
});
