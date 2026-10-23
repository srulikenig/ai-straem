import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { Logger } from '../logger.js';
import { config } from '../config.js';
import { encodeWav, frameBytes, layTrack, mixPcm, type TimedPcm } from '../audio/pcm.js';
import { PbxWriter } from './writer.js';
import {
  clearCommand,
  hangupCommand,
  isFinalCommand,
  parseInbound,
  saveAnswerCommand,
  transferExtensionCommand,
  transferPhoneCommand,
  type OutboundCommand,
  type StartMessage,
} from './protocol.js';

/** What a tool is allowed to do to the live call. */
export interface CallActions {
  saveAnswer(name: string, value: string): void;
  transferExtension(target: string): void;
  transferPhone(target: string): void;
  endCall(): void;
  /** True once a final command has been sent — no second one is permitted. */
  readonly closing: boolean;
}

export interface PbxSessionEvents {
  start: [StartMessage];
  audio: [Buffer];
  dtmf: [string];
  hangup: [];
  close: [];
  /** After the recordings are on disk; null when recording is off or failed. */
  finished: [recordingDir: string | null];
}

/** Cap in-memory recordings so a stuck call cannot eat the box. */
const MAX_RECORD_BYTES = 10 * 60 * config.pbx.sampleRate * 2;

/**
 * One phone call: the PBX socket, the paced writer, and the call-control
 * surface tools reach for. Deliberately knows nothing about any AI model.
 */
export class PbxSession extends EventEmitter<PbxSessionEvents> implements CallActions {
  readonly id = randomUUID().slice(0, 8);
  readonly log: Logger;
  readonly writer: PbxWriter;

  callId: string | null = null;
  caller: string | null = null;
  extension: string | null = null;
  startedAt = Date.now();
  /** Everything saved with save_answer, last value wins. */
  readonly answers: Record<string, string> = {};

  private closed = false;
  private drainTimer: NodeJS.Timeout | null = null;
  private maxCallTimer: NodeJS.Timeout | null = null;
  /** Recording timeline origin; unlike startedAt it never moves. */
  private readonly connectedAt = Date.now();
  private recIn: TimedPcm[] = [];
  private recOut: TimedPcm[] = [];
  private recInBytes = 0;
  private recOutBytes = 0;

  constructor(
    private readonly ws: WebSocket,
    parentLog: Logger,
  ) {
    super();
    this.log = parentLog.child({ call: this.id });
    this.writer = new PbxWriter(ws, {
      frameBytes: frameBytes(config.pbx.sampleRate, config.pbx.frameMs),
      frameMs: config.pbx.frameMs,
      queueWarnMs: config.pbx.queueWarnMs,
      log: this.log,
      // Recorded as sent, not as queued: audio dropped by a barge-in was never heard.
      onFrameSent: (frame) => {
        if (config.recordDir && this.recOutBytes < MAX_RECORD_BYTES) {
          this.recOut.push({ atMs: Date.now() - this.connectedAt, pcm: frame });
          this.recOutBytes += frame.length;
        }
      },
    });

    ws.on('message', (data, isBinary) => this.onMessage(data as Buffer, isBinary));
    ws.on('close', (code, reason) => {
      this.log.info({ code, reason: reason.toString() }, 'pbx socket closed');
      void this.finish();
    });
    ws.on('error', (err) => this.log.error({ err }, 'pbx socket error'));

    this.writer.start();
    this.maxCallTimer = setTimeout(() => {
      this.log.warn({ seconds: config.server.maxCallSeconds }, 'max call duration reached, hanging up');
      this.endCall();
    }, config.server.maxCallSeconds * 1000);
  }

  get closing(): boolean {
    return this.writer.finalSent || this.closed;
  }

  get durationMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Queue bot audio (8 kHz PCM) for playback. */
  play(pcm8k: Buffer): void {
    this.writer.enqueueAudio(pcm8k);
  }

  /** Barge-in: drop our queue and tell the PBX to drop its own. */
  clearPlayback(reason: string): void {
    if (this.closing) return;
    const dropped = this.writer.dropQueuedAudio();
    this.writer.sendCommand(clearCommand());
    this.log.info({ reason, droppedMs: Math.round(dropped) }, 'barge-in: playback cleared');
  }

  saveAnswer(name: string, value: string): void {
    this.answers[name] = value;
    this.writer.sendCommand(saveAnswerCommand(name, value));
  }

  transferExtension(target: string): void {
    this.sendFinal(transferExtensionCommand(target));
  }

  transferPhone(target: string): void {
    this.sendFinal(transferPhoneCommand(target));
  }

  endCall(): void {
    this.sendFinal(hangupCommand());
  }

  /**
   * Send the one final command, then keep pacing audio so the caller actually
   * hears the closing sentence — the PBX drains for up to six seconds before it
   * acts. We hold the socket open a little longer than that, then give up.
   */
  private sendFinal(cmd: OutboundCommand): void {
    if (!isFinalCommand(cmd)) throw new Error(`not a final command: ${cmd.type}`);
    if (this.closing) {
      this.log.warn({ cmd }, 'call already closing; final command ignored');
      return;
    }
    this.writer.sendCommand(cmd);
    this.drainTimer = setTimeout(() => {
      this.log.info('drain window elapsed; closing socket');
      this.ws.close(1000, 'done');
    }, config.pbx.finalDrainMs);
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      if (config.recordDir && this.recInBytes < MAX_RECORD_BYTES) {
        this.recIn.push({ atMs: Date.now() - this.connectedAt, pcm: Buffer.from(data) });
        this.recInBytes += data.length;
      }
      this.emit('audio', data);
      return;
    }

    const text = data.toString('utf8');
    const msg = parseInbound(text);
    if (!msg) {
      this.log.warn({ text: text.slice(0, 400) }, 'pbx -> unparseable text frame');
      return;
    }
    // Always log the raw object: it is how the real field names get discovered.
    this.log.debug({ raw: msg.raw }, `pbx -> ${msg.type}`);

    switch (msg.type) {
      case 'start':
        this.callId = msg.callId;
        this.caller = msg.caller;
        this.extension = msg.extension;
        this.startedAt = Date.now();
        this.log.info({ callId: msg.callId, caller: msg.caller, extension: msg.extension }, 'call started');
        this.emit('start', msg);
        break;
      case 'dtmf':
        this.log.info({ digit: msg.digit }, 'caller pressed a key');
        this.emit('dtmf', msg.digit);
        break;
      case 'hangup':
        this.log.info('caller hung up');
        this.emit('hangup');
        void this.finish();
        break;
      default:
        this.log.warn({ raw: msg.raw }, 'pbx -> unknown message type');
    }
  }

  private async finish(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    if (this.maxCallTimer) clearTimeout(this.maxCallTimer);
    this.writer.stop();
    this.emit('close');
    const recordingDir = await this.dumpRecordings();
    this.log.info({ durationMs: this.durationMs }, 'call finished');
    this.emit('finished', recordingDir);
  }

  /** caller.wav and bot.wav per side, call.wav as the caller heard it. */
  private async dumpRecordings(): Promise<string | null> {
    if (!config.recordDir) return null;
    try {
      const dir = join(config.recordDir, `${new Date(this.startedAt).toISOString().replace(/[:.]/g, '-')}_${this.id}`);
      await mkdir(dir, { recursive: true });
      const rate = config.pbx.sampleRate;
      const caller = layTrack(this.recIn, rate);
      const bot = layTrack(this.recOut, rate);
      await Promise.all([
        writeFile(join(dir, 'caller.wav'), encodeWav(caller, rate)),
        writeFile(join(dir, 'bot.wav'), encodeWav(bot, rate)),
        writeFile(join(dir, 'call.wav'), encodeWav(mixPcm(caller, bot), rate)),
        writeFile(
          join(dir, 'meta.json'),
          JSON.stringify(
            { id: this.id, callId: this.callId, caller: this.caller, extension: this.extension, durationMs: this.durationMs, answers: this.answers },
            null,
            2,
          ),
        ),
      ]);
      this.log.info({ dir }, 'recordings written');
      return dir;
    } catch (err) {
      this.log.error({ err }, 'failed to write recordings');
      return null;
    }
  }
}
