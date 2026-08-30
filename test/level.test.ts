import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmsDbfs, SpeechGate } from '../src/audio/level.js';
import { floatToPcm16, silence } from '../src/audio/pcm.js';

const FRAME_MS = 20;
const FRAME_SAMPLES = 160; // 20 ms at 8 kHz

function frame(amplitude: number): Buffer {
  const a = new Float32Array(FRAME_SAMPLES);
  for (let i = 0; i < FRAME_SAMPLES; i++) a[i] = amplitude * Math.sin((2 * Math.PI * 300 * i) / 8000);
  return floatToPcm16(a);
}

const gate = () =>
  new SpeechGate({ thresholdDbfs: -45, onsetFrames: 3, hangoverMs: 200, frameMs: FRAME_MS });

test('silence measures as -Infinity dBFS', () => {
  assert.equal(rmsDbfs(silence(8000, 20)), -Infinity);
});

test('speech onset needs several consecutive loud frames', () => {
  const g = gate();
  assert.equal(g.push(frame(0.3)).onset, false);
  assert.equal(g.push(frame(0.3)).onset, false);
  assert.equal(g.push(frame(0.3)).onset, true, 'third loud frame triggers onset');
  assert.equal(g.push(frame(0.3)).onset, false, 'onset fires once per burst');
  assert.equal(g.speaking, true);
});

test('an isolated click does not trigger onset', () => {
  const g = gate();
  g.push(frame(0.3));
  g.push(frame(0));
  g.push(frame(0.3));
  g.push(frame(0));
  assert.equal(g.speaking, false);
});

test('speaking stays true through the hangover, then drops', () => {
  const g = gate();
  for (let i = 0; i < 3; i++) g.push(frame(0.3));
  assert.equal(g.speaking, true);

  // 200 ms hangover = 10 frames of 20 ms.
  for (let i = 0; i < 9; i++) g.push(frame(0));
  assert.equal(g.speaking, true, 'still within the hangover window');
  g.push(frame(0));
  assert.equal(g.speaking, false, 'hangover elapsed');
});

test('room tone below the threshold never counts as speech', () => {
  const g = gate();
  for (let i = 0; i < 50; i++) g.push(frame(0.0005));
  assert.equal(g.speaking, false);
});
