import { EventEmitter } from 'node:events';
import {
  GoogleGenAI,
  Modality,
  type FunctionCall,
  type FunctionDeclaration,
  type FunctionResponse,
  type LiveServerMessage,
  type Session,
} from '@google/genai';
import type { Logger } from '../logger.js';

export interface GeminiLiveOptions {
  apiKey: string;
  model: string;
  voice: string;
  languageCode: string | null;
  temperature: number;
  systemInstruction: string;
  functionDeclarations: FunctionDeclaration[];
  inputSampleRate: number;
  transcripts: boolean;
  vadSilenceMs: number | null;
  vadPrefixPaddingMs: number | null;
  log: Logger;
}

export interface GeminiLiveEvents {
  ready: [];
  /** Model speech, PCM16 at the model's own output rate (24 kHz). */
  audio: [Buffer];
  /** The model was cut off — stop playing whatever is queued. */
  interrupted: [];
  turnComplete: [];
  toolCall: [FunctionCall[]];
  toolCallCancellation: [string[]];
  transcript: [{ role: 'caller' | 'bot'; text: string }];
  /** The session is about to be recycled by the server. */
  goAway: [string];
  error: [Error];
  close: [{ code?: number; reason?: string }];
}

/**
 * Thin adapter over the Gemini Live websocket session.
 *
 * Everything model-specific lives here: swapping to another realtime provider
 * means writing one more class with these same events, and nothing else in the
 * project changes.
 */
export class GeminiLive extends EventEmitter<GeminiLiveEvents> {
  private session: Session | null = null;
  private closed = false;
  private setupDone = false;
  private readonly log: Logger;

  constructor(private readonly opts: GeminiLiveOptions) {
    super();
    this.log = opts.log.child({ component: 'gemini' });
  }

  async connect(): Promise<void> {
    const ai = new GoogleGenAI({ apiKey: this.opts.apiKey });

    const automaticActivityDetection: Record<string, number> = {};
    if (this.opts.vadPrefixPaddingMs !== null) automaticActivityDetection['prefixPaddingMs'] = this.opts.vadPrefixPaddingMs;
    if (this.opts.vadSilenceMs !== null) automaticActivityDetection['silenceDurationMs'] = this.opts.vadSilenceMs;

    this.session = await ai.live.connect({
      model: this.opts.model,
      config: {
        responseModalities: [Modality.AUDIO],
        temperature: this.opts.temperature,
        systemInstruction: this.opts.systemInstruction,
        speechConfig: {
          ...(this.opts.languageCode ? { languageCode: this.opts.languageCode } : {}),
          voiceConfig: { prebuiltVoiceConfig: { voiceName: this.opts.voice } },
        },
        ...(this.opts.functionDeclarations.length
          ? { tools: [{ functionDeclarations: this.opts.functionDeclarations }] }
          : {}),
        ...(this.opts.transcripts ? { inputAudioTranscription: {}, outputAudioTranscription: {} } : {}),
        ...(Object.keys(automaticActivityDetection).length ? { realtimeInputConfig: { automaticActivityDetection } } : {}),
      },
      callbacks: {
        onopen: () => {
          this.log.info({ model: this.opts.model }, 'live session open');
        },
        onmessage: (msg) => this.onMessage(msg),
        onerror: (e) => {
          this.log.error({ err: e.message }, 'live session error');
          this.emit('error', new Error(e.message ?? 'gemini live error'));
        },
        onclose: (e) => {
          this.closed = true;
          this.log.info({ code: e.code, reason: e.reason }, 'live session closed');
          this.emit('close', { code: e.code, reason: e.reason });
        },
      },
    });
    this.maybeReady();
  }

  /** Caller audio, already resampled to the model's input rate. */
  sendAudio(pcm: Buffer): void {
    if (!this.session || this.closed) return;
    this.session.sendRealtimeInput({
      audio: { data: pcm.toString('base64'), mimeType: `audio/pcm;rate=${this.opts.inputSampleRate}` },
    });
  }

  /** An ordered turn — used for the opening line and for DTMF notifications. */
  sendText(text: string, turnComplete = true): void {
    if (!this.session || this.closed) return;
    this.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete });
  }

  sendToolResponses(functionResponses: FunctionResponse[]): void {
    if (!this.session || this.closed || functionResponses.length === 0) return;
    this.session.sendToolResponse({ functionResponses });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.session?.close();
    } catch (err) {
      this.log.debug({ err }, 'error while closing live session');
    }
  }

  /**
   * setupComplete can arrive before connect() resolves, i.e. before
   * this.session is assigned, and anything sent then is silently dropped.
   * Ready means both: the model accepts input and we hold the session.
   */
  private maybeReady(): void {
    if (!this.setupDone || !this.session || this.closed) return;
    this.emit('ready');
  }

  private onMessage(msg: LiveServerMessage): void {
    if (msg.setupComplete) {
      this.log.debug('setup complete');
      this.setupDone = true;
      this.maybeReady();
    }

    const content = msg.serverContent;
    if (content) {
      for (const part of content.modelTurn?.parts ?? []) {
        const inline = part.inlineData;
        if (inline?.data && inline.mimeType?.startsWith('audio/pcm')) {
          this.emit('audio', Buffer.from(inline.data, 'base64'));
        }
      }
      const inText = content.inputTranscription?.text;
      if (inText) this.emit('transcript', { role: 'caller', text: inText });
      const outText = content.outputTranscription?.text;
      if (outText) this.emit('transcript', { role: 'bot', text: outText });

      if (content.interrupted) this.emit('interrupted');
      if (content.turnComplete) this.emit('turnComplete');
    }

    if (msg.toolCall?.functionCalls?.length) this.emit('toolCall', msg.toolCall.functionCalls);
    if (msg.toolCallCancellation?.ids?.length) this.emit('toolCallCancellation', msg.toolCallCancellation.ids);
    if (msg.goAway) this.emit('goAway', msg.goAway.timeLeft ?? 'unknown');
    if (msg.usageMetadata) this.log.debug({ usage: msg.usageMetadata }, 'usage');
  }
}
