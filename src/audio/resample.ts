import { floatToPcm16, pcm16ToFloat } from './pcm.js';

/**
 * Windowed-sinc low-pass, Blackman window. `gain` folds the interpolation gain
 * (L) into the taps so the polyphase output needs no extra scaling.
 */
export function lowpassTaps(cutoffHz: number, sampleRate: number, numTaps: number, gain = 1): Float32Array {
  if (numTaps % 2 === 0) numTaps += 1; // a symmetric filter needs an odd length
  const taps = new Float32Array(numTaps);
  const fc = cutoffHz / sampleRate; // normalised: cycles per sample
  const mid = (numTaps - 1) / 2;
  let sum = 0;

  for (let i = 0; i < numTaps; i++) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (numTaps - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (numTaps - 1));
    const v = sinc * w;
    taps[i] = v;
    sum += v;
  }
  // Normalise to unity DC gain, then apply the interpolation gain.
  for (let i = 0; i < numTaps; i++) taps[i] = (taps[i]! / sum) * gain;
  return taps;
}

/**
 * Streaming rational resampler (interpolate by L, decimate by M), built as a
 * polyphase filter bank.
 *
 * Two properties earn their keep here:
 * - It is *streaming*: filter history carries across calls, so 20 ms frame
 *   boundaries produce no clicks.
 * - It is decimation-aware: only the samples that survive are computed, rather
 *   than filtering the whole L*inRate stream and throwing most of it away.
 */
export class Resampler {
  readonly L: number;
  readonly M: number;

  private readonly phases: Float32Array[];
  private readonly historyLen: number;
  private hist: Float32Array;
  /** Offset of the next output's base sample, relative to the next input buffer. */
  private nextOffset = 0;
  private phase = 0;

  constructor(readonly inRate: number, readonly outRate: number) {
    const g = gcd(inRate, outRate);
    this.L = outRate / g;
    this.M = inRate / g;

    // Anti-alias at the lower of the two Nyquist limits, with 10% headroom.
    // Skipping this on a downsample is exactly what makes speech sound metallic.
    const workRate = inRate * this.L;
    const cutoff = (Math.min(inRate, outRate) / 2) * 0.9;
    const numTaps = Math.max(this.L, this.M) * 32 + 1;
    const taps = lowpassTaps(cutoff, workRate, numTaps, this.L);

    const perPhase = Math.ceil(taps.length / this.L);
    this.phases = [];
    for (let p = 0; p < this.L; p++) {
      const phase = new Float32Array(perPhase);
      for (let t = 0; t < perPhase; t++) {
        const idx = p + t * this.L;
        phase[t] = idx < taps.length ? taps[idx]! : 0;
      }
      this.phases.push(phase);
    }

    this.historyLen = perPhase - 1;
    this.hist = new Float32Array(this.historyLen);
  }

  process(input: Float32Array): Float32Array {
    if (input.length === 0) return new Float32Array(0);

    const H = this.historyLen;
    const buf = new Float32Array(H + input.length);
    buf.set(this.hist);
    buf.set(input, H);

    // Count first so the output array is allocated once.
    let count = 0;
    for (let off = this.nextOffset, p = this.phase; off < input.length; ) {
      count++;
      const num = p + this.M;
      p = num % this.L;
      off += Math.floor(num / this.L);
    }

    const out = new Float32Array(count);
    let off = this.nextOffset;
    let p = this.phase;
    for (let k = 0; k < count; k++) {
      const taps = this.phases[p]!;
      const bi = H + off;
      let acc = 0;
      for (let t = 0; t < taps.length; t++) {
        const idx = bi - t;
        if (idx < 0) break; // only reachable while the history is still filling
        acc += taps[t]! * buf[idx]!;
      }
      out[k] = acc;
      const num = p + this.M;
      p = num % this.L;
      off += Math.floor(num / this.L);
    }

    this.nextOffset = off - input.length;
    this.phase = p;
    this.hist = buf.slice(buf.length - H);
    return out;
  }

  processPcm(pcm: Buffer): Buffer {
    return floatToPcm16(this.process(pcm16ToFloat(pcm)));
  }

  reset(): void {
    this.hist = new Float32Array(this.historyLen);
    this.nextOffset = 0;
    this.phase = 0;
  }
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Caller's voice on its way to the model: 8 kHz telephony -> 16 kHz model input. */
export const upTo16k = (): Resampler => new Resampler(8000, 16000);
/** Model's voice on its way back to the line: 24 kHz -> 8 kHz telephony. */
export const downTo8k = (): Resampler => new Resampler(24000, 8000);
