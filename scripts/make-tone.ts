/**
 * Generates a test wav so the mock PBX has something to "say" before you have a
 * real recording: bursts of a speech-band tone separated by silence, which is
 * enough to exercise the energy gate and the barge-in path.
 *
 *   npm run tone -- tmp/caller.wav
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { encodeWav, floatToPcm16 } from '../src/audio/pcm.js';

const out = process.argv[2] ?? 'tmp/caller.wav';
const RATE = 8000;
const plan: Array<[kind: 'tone' | 'quiet', seconds: number]> = [
  ['quiet', 1.5],
  ['tone', 2.0],
  ['quiet', 3.0],
  ['tone', 1.5],
  ['quiet', 2.0],
];

const total = plan.reduce((n, [, s]) => n + Math.round(s * RATE), 0);
const samples = new Float32Array(total);
let i = 0;
for (const [kind, seconds] of plan) {
  const n = Math.round(seconds * RATE);
  for (let k = 0; k < n; k++, i++) {
    if (kind === 'quiet') {
      samples[i] = (Math.random() - 0.5) * 0.0008; // room tone, below the gate
    } else {
      // Two speech-band partials with an envelope, so it is not a flat sine.
      const t = k / RATE;
      const env = Math.min(1, t * 8, (n - k) / RATE * 8);
      samples[i] = env * 0.28 * (Math.sin(2 * Math.PI * 320 * t) + 0.5 * Math.sin(2 * Math.PI * 850 * t));
    }
  }
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, encodeWav(floatToPcm16(samples), RATE));
console.log(`wrote ${out} (${(total / RATE).toFixed(1)}s at ${RATE} Hz)`);
