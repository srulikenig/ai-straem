import { BYTES_PER_SAMPLE } from './pcm.js';

/** RMS of a PCM16 frame in dBFS. Silence returns -Infinity. */
export function rmsDbfs(pcm: Buffer): number {
  const n = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  if (n === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n);
  return rms === 0 ? -Infinity : 20 * Math.log10(rms);
}

export interface SpeechGateOptions {
  thresholdDbfs: number;
  /** Frames above threshold before we call it speech — rejects single clicks. */
  onsetFrames: number;
  /** Keep reporting "speaking" this long after the level drops. */
  hangoverMs: number;
  frameMs: number;
}

export interface GateResult {
  /** Level is above threshold right now. */
  loud: boolean;
  /** Speech is active, hangover included. */
  speaking: boolean;
  /** True on the frame where speech starts — the barge-in trigger. */
  onset: boolean;
  dbfs: number;
}

/**
 * Energy gate with onset debouncing and a hangover tail.
 *
 * It answers two different questions with one measurement:
 * - "Did the caller actually start talking?" (onset) — so a cough or line noise
 *   does not cut the bot off mid-sentence.
 * - "Is it worth forwarding this frame to the model?" (speaking) — silence is
 *   billed as input audio, and a long call is mostly silence.
 *
 * The hangover is why speech-end still reaches the model: we keep forwarding
 * for a moment after the level drops, so the model's own VAD sees the trailing
 * silence and closes the turn instead of waiting forever.
 */
export class SpeechGate {
  private loudRun = 0;
  private quietMs = Infinity;
  private active = false;

  constructor(private readonly opts: SpeechGateOptions) {}

  push(pcm: Buffer): GateResult {
    const dbfs = rmsDbfs(pcm);
    const loud = dbfs > this.opts.thresholdDbfs;
    let onset = false;

    if (loud) {
      this.loudRun++;
      this.quietMs = 0;
      if (!this.active && this.loudRun >= this.opts.onsetFrames) {
        this.active = true;
        onset = true;
      }
    } else {
      this.loudRun = 0;
      this.quietMs += this.opts.frameMs;
      if (this.active && this.quietMs >= this.opts.hangoverMs) this.active = false;
    }

    return { loud, speaking: this.active, onset, dbfs };
  }

  get speaking(): boolean {
    return this.active;
  }

  /** Milliseconds since the level last exceeded the threshold. */
  get silentForMs(): number {
    return this.quietMs;
  }

  reset(): void {
    this.loudRun = 0;
    this.quietMs = Infinity;
    this.active = false;
  }
}
