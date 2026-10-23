import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layTrack, mixPcm } from '../src/audio/pcm.js';

const RATE = 8000;
const FRAME = 320; // 20 ms

function frame(value: number): Buffer {
  const b = Buffer.alloc(FRAME);
  for (let i = 0; i < FRAME; i += 2) b.writeInt16LE(value, i);
  return b;
}

test('chunks that arrive with jitter are laid back to back', () => {
  const out = layTrack(
    [
      { atMs: 0, pcm: frame(1) },
      { atMs: 35, pcm: frame(2) }, // late, but within the slack
      { atMs: 38, pcm: frame(3) }, // early relative to the cursor
    ],
    RATE,
  );
  assert.equal(out.length, FRAME * 3);
  assert.equal(out.readInt16LE(FRAME), 2);
  assert.equal(out.readInt16LE(FRAME * 2), 3);
});

test('a real pause becomes silence at the right place', () => {
  const out = layTrack(
    [
      { atMs: 0, pcm: frame(1) },
      { atMs: 1000, pcm: frame(2) },
    ],
    RATE,
  );
  const second = (RATE * 2 * 1000) / 1000;
  assert.equal(out.length, second + FRAME);
  assert.equal(out.readInt16LE(FRAME), 0);
  assert.equal(out.readInt16LE(second), 2);
});

test('mixing sums both sides, pads the shorter one and clips', () => {
  const a = Buffer.concat([frame(1000), frame(30000)]);
  const b = frame(500);
  const out = mixPcm(Buffer.from(a), Buffer.concat([b, frame(30000)]));
  assert.equal(out.readInt16LE(0), 1500);
  assert.equal(out.readInt16LE(FRAME), 32767);
  assert.equal(mixPcm(a, b).readInt16LE(FRAME), 30000);
});
