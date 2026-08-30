import type { WebSocket } from 'ws';
import type { Logger } from '../logger.js';
import { isFinalCommand, type OutboundCommand } from './protocol.js';

export interface WriterOptions {
  frameBytes: number;
  frameMs: number;
  queueWarnMs: number;
  log: Logger;
}

/**
 * The single writer to the PBX socket, and the only place that paces audio.
 *
 * Two vendor warnings collapse into this one class:
 *
 * 1. *Real-time rate.* The model produces audio far faster than it takes to
 *    play. Dumping it all into the socket makes the PBX buffer grow and the
 *    caller hears an ever-increasing delay. So: one 20 ms frame every 20 ms,
 *    on a drift-corrected clock.
 * 2. *Single writer.* Audio and commands originate in different async paths.
 *    Everything goes through this one queue, in order, so nothing interleaves.
 *
 * Commands jump ahead of queued audio (they are control, not content) but still
 * leave through the same tick, which keeps ordering deterministic.
 */
export class PbxWriter {
  private audio: Buffer[] = [];
  private partial: Buffer = Buffer.alloc(0);
  private commands: OutboundCommand[] = [];
  private timer: NodeJS.Timeout | null = null;
  private nextAt = 0;
  private stopped = false;
  private warned = false;
  private finalSentAt: number | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly opts: WriterOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.nextAt = Date.now();
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Queue 8 kHz PCM for playback. Split into exact frames; remainders carry over. */
  enqueueAudio(pcm: Buffer): void {
    if (this.stopped || pcm.length === 0) return;
    let buf = this.partial.length ? Buffer.concat([this.partial, pcm]) : pcm;
    const size = this.opts.frameBytes;
    let off = 0;
    while (buf.length - off >= size) {
      this.audio.push(buf.subarray(off, off + size));
      off += size;
    }
    this.partial = off < buf.length ? Buffer.from(buf.subarray(off)) : Buffer.alloc(0);

    if (!this.warned && this.queuedMs > this.opts.queueWarnMs) {
      this.warned = true;
      this.opts.log.warn({ queuedMs: Math.round(this.queuedMs) }, 'playback queue is unusually deep');
    }
  }

  sendCommand(cmd: OutboundCommand): void {
    if (this.stopped) return;
    if (isFinalCommand(cmd)) {
      if (this.finalSentAt !== null) {
        this.opts.log.warn({ cmd }, 'ignoring second final command; one per call');
        return;
      }
      this.finalSentAt = Date.now();
    }
    this.commands.push(cmd);
  }

  /**
   * Barge-in: throw away everything still waiting to be played. The `clear`
   * command tells the PBX to do the same with what it already buffered.
   */
  dropQueuedAudio(): number {
    const dropped = this.queuedMs;
    this.audio = [];
    this.partial = Buffer.alloc(0);
    this.warned = false;
    return dropped;
  }

  get queuedMs(): number {
    const bytes = this.audio.length * this.opts.frameBytes + this.partial.length;
    return (bytes / this.opts.frameBytes) * this.opts.frameMs;
  }

  get finalSent(): boolean {
    return this.finalSentAt !== null;
  }

  /** Milliseconds since the final command left, or null if none was sent. */
  get msSinceFinal(): number | null {
    return this.finalSentAt === null ? null : Date.now() - this.finalSentAt;
  }

  private tick = (): void => {
    if (this.stopped) return;
    const now = Date.now();

    // Catch up on missed ticks (the event loop stalled), but cap the burst so a
    // long stall cannot flood the socket in one go.
    let budget = 5;
    while (this.nextAt <= now && budget-- > 0) {
      this.flushOnce();
      this.nextAt += this.opts.frameMs;
    }
    if (this.nextAt < now) this.nextAt = now + this.opts.frameMs; // resync after a big stall

    this.timer = setTimeout(this.tick, Math.max(1, this.nextAt - Date.now()));
  };

  private flushOnce(): void {
    if (this.ws.readyState !== this.ws.OPEN) return;

    // Commands first: `clear` is only useful if it beats the audio behind it.
    while (this.commands.length) {
      const cmd = this.commands.shift()!;
      this.ws.send(JSON.stringify(cmd));
      this.opts.log.info({ cmd }, 'pbx <- command');
    }

    const frame = this.audio.shift();
    if (frame) this.ws.send(frame, { binary: true });
  }
}
