import type { FunctionCall, FunctionResponse } from '@google/genai';
import { config } from '../config.js';
import { SpeechGate } from '../audio/level.js';
import { downTo8k, upTo16k } from '../audio/resample.js';
import { GeminiLive } from '../gemini/liveClient.js';
import type { PbxSession } from '../pbx/session.js';
import { buildRegistry, type ToolContext, type ToolRegistry } from '../tools/index.js';
import { BlessingAudit } from './blessingAudit.js';
import type { RequestReport, TranscriptTurn } from './requestReport.js';

/**
 * Wires one phone call to one model session.
 *
 * Caller  -> gate -> 8k→16k -> Gemini
 * Gemini  -> 24k→8k -> paced writer -> caller
 * Gemini  -> tool call -> registry -> tool response -> Gemini
 */
export class CallBridge {
  private readonly gemini: GeminiLive;
  private readonly registry: ToolRegistry;
  private readonly toCaller = downTo8k();
  private readonly toModel = upTo16k();
  private readonly gate = new SpeechGate({
    thresholdDbfs: config.audio.speechThresholdDbfs,
    onsetFrames: config.audio.speechOnsetFrames,
    hangoverMs: config.audio.speechHangoverMs,
    frameMs: config.pbx.frameMs,
  });

  private readonly audit: BlessingAudit;

  private ready = false;
  private stopped = false;
  private suppressedFrames = 0;
  /** Output transcription arrives in fragments; audited once the turn closes. */
  private botTurn = '';
  /** The whole conversation, with each speaker's fragments joined into turns. */
  private readonly transcript: TranscriptTurn[] = [];

  constructor(private readonly session: PbxSession) {
    this.audit = new BlessingAudit({ log: session.log, strict: config.blessings.auditStrict });
    this.registry = buildRegistry({
      onBlessingServed: (blessing) => this.audit.recordServed(blessing),
    });
    this.gemini = new GeminiLive({
      apiKey: config.gemini.apiKey,
      model: config.gemini.model,
      voice: config.gemini.voice,
      languageCode: config.gemini.languageCode,
      temperature: config.gemini.temperature,
      systemInstruction: config.gemini.systemPrompt,
      functionDeclarations: this.registry.functionDeclarations(),
      inputSampleRate: config.gemini.inputSampleRate,
      transcripts: config.gemini.transcripts,
      vadSilenceMs: config.gemini.vadSilenceMs,
      vadPrefixPaddingMs: config.gemini.vadPrefixPaddingMs,
      log: session.log,
    });
  }

  async start(): Promise<void> {
    this.wirePbx();
    this.wireGemini();
    this.session.log.info({ tools: this.registry.names }, 'connecting to the model');
    await this.gemini.connect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.flushBotTurn();
    if (config.blessings.audit) this.audit.logSummary();
    this.gemini.close();
  }

  /* ------------------------------- PBX side ------------------------------- */

  private wirePbx(): void {
    this.session.on('audio', (pcm8k) => this.onCallerAudio(pcm8k));
    this.session.on('dtmf', (digit) => {
      // Ordered turn rather than realtime input: a keypress is an event the
      // model must react to, not background audio.
      this.gemini.sendText(`(המתקשר הקיש במקלדת הטלפון: ${digit})`);
    });
    this.session.on('hangup', () => this.stop());
    this.session.on('close', () => this.stop());
  }

  private onCallerAudio(pcm8k: Buffer): void {
    if (!this.ready || this.stopped) return;
    const gate = this.gate.push(pcm8k);

    // Silence is billed as input audio, and most of a call is silence. The
    // hangover keeps the tail flowing so the model's VAD still sees speech end.
    if (config.audio.suppressSilence && !gate.speaking) {
      this.suppressedFrames++;
      return;
    }
    this.gemini.sendAudio(this.toModel.processPcm(pcm8k));
  }

  /* ------------------------------ model side ------------------------------ */

  private wireGemini(): void {
    this.gemini.on('ready', () => {
      this.ready = true;
      // A voice model waits to be spoken to; the caller waits for the answer.
      // Without this nudge both sides sit in silence until someone gives up.
      this.gemini.sendText(
        `(השיחה נפתחה כעת${this.session.caller ? `. מספר המתקשר: ${this.session.caller}` : ''}. פתח אתה, במשפט אחד: "${config.gemini.greeting}")`,
      );
    });

    this.gemini.on('audio', (pcm24k) => {
      if (this.stopped) return;
      this.session.play(this.toCaller.processPcm(pcm24k));
    });

    // A cut-off turn still needs auditing: half a blessing is still a blessing.
    this.gemini.on('interrupted', () => {
      this.flushBotTurn();
      // The model's own VAD also fires on background noise. Requiring our energy
      // gate to agree is what stops the bot being cut off by a passing truck.
      if (config.audio.gateBargeIn && !this.gate.speaking) {
        this.session.log.debug({ silentForMs: this.gate.silentForMs }, 'ignoring interrupt: no speech energy');
        return;
      }
      this.session.clearPlayback('model interrupted');
    });

    this.gemini.on('toolCall', (calls) => void this.runTools(calls));

    this.gemini.on('toolCallCancellation', (ids) => {
      this.session.log.info({ ids }, 'model cancelled tool calls');
    });

    this.gemini.on('transcript', ({ role, text }) => {
      this.session.log.info({ role, text }, 'transcript');
      if (role === 'bot') this.botTurn += text;
      const last = this.transcript.at(-1);
      if (last?.role === role) last.text += text;
      else this.transcript.push({ role, text });
    });

    this.gemini.on('turnComplete', () => this.flushBotTurn());

    this.gemini.on('goAway', (timeLeft) => {
      this.session.log.warn({ timeLeft }, 'model session is going away');
    });

    this.gemini.on('error', (err) => {
      this.session.log.error({ err }, 'model error; ending the call');
      this.session.endCall();
    });

    this.gemini.on('close', () => {
      if (this.stopped || this.session.closing) return;
      this.session.log.warn('model session closed unexpectedly; ending the call');
      this.session.endCall();
    });
  }

  /**
   * The model may ask for several tools at once. Run them together, but always
   * answer every call — a missing response leaves the conversation stalled.
   */
  private async runTools(calls: FunctionCall[]): Promise<void> {
    const ctx: ToolContext = {
      callId: this.session.callId ?? this.session.id,
      caller: this.session.caller,
      call: this.session,
      log: this.session.log,
    };

    const responses: FunctionResponse[] = await Promise.all(
      calls.map(async (call): Promise<FunctionResponse> => {
        const name = call.name ?? '';
        const result = await this.registry.execute(name, call.args ?? {}, ctx);
        return { id: call.id, name, response: result };
      }),
    );

    if (this.stopped) return;
    this.gemini.sendToolResponses(responses);
  }

  private flushBotTurn(): void {
    const turn = this.botTurn.trim();
    this.botTurn = '';
    if (!turn || !config.blessings.audit) return;
    this.audit.checkTurn(turn);
  }

  report(recordingDir: string | null): RequestReport {
    return {
      caller: this.session.caller,
      callId: this.session.callId,
      startedAt: new Date(this.session.startedAt),
      durationMs: this.session.durationMs,
      answers: { ...this.session.answers },
      transcript: this.transcript,
      recording: recordingDir ? `${recordingDir}/call.wav` : null,
    };
  }

  get stats(): Record<string, unknown> {
    return {
      suppressedFrames: this.suppressedFrames,
      queuedMs: Math.round(this.session.writer.queuedMs),
      blessingAudit: this.audit.summary,
    };
  }
}
