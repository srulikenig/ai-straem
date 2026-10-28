import 'dotenv/config';
import { readFileSync } from 'node:fs';

function str(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${name}`);
}

function num(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got "${v}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * `echo` never talks to Gemini — it loops the caller's own voice back through
 * the pacing writer. It is the cheapest way to prove the PBX link works.
 */
export type Mode = 'bot' | 'echo';

const mode = str('MODE', 'bot') as Mode;
if (mode !== 'bot' && mode !== 'echo') throw new Error(`MODE must be "bot" or "echo", got "${mode}"`);

function systemPrompt(): string {
  const file = process.env.SYSTEM_PROMPT_FILE?.trim();
  if (file) return readFileSync(file, 'utf8');
  return str('SYSTEM_PROMPT', DEFAULT_SYSTEM_PROMPT);
}

/**
 * Written for the phone, not for chat: short turns, no lists, no markdown, and
 * an explicit instruction to speak a filler line before reaching for a tool —
 * a silent tool call sounds like a dropped call.
 */
const DEFAULT_SYSTEM_PROMPT = `אתה נציג טלפוני ממוחשב של "טכנוליין דמו".
דבר עברית בלבד, במשפטים קצרים כמו בשיחת טלפון אמיתית.
אל תקריא רשימות, אל תשתמש בסימני עיצוב, ואל תאיית כתובות אינטרנט.
מספרים וסכומים אמור במילים, בצורה שנוח לשמוע אותה.

לפני שאתה קורא לכלי שלוקח זמן, אמור משפט קצר כמו "רגע, בודק" — אחרת המתקשר שומע שקט.
אם כלי מחזיר שגיאה, אמור זאת בפשטות והצע דרך אחרת. אל תמציא נתונים שלא קיבלת מכלי.

שני כללים מוחלטים:
1. חישובים. אסור לך לחשב בראש, גם לא חישוב פשוט. כל פעולה חשבונית עוברת
   דרך הכלי calculate, ואתה אומר בדיוק את מה שהוא החזיר בשדה spoken.
   אם אמרת מספר שלא קיבלת מהכלי — טעית.
2. איחולים. אסור לך לנסח איחול בעצמך, אפילו לא מילה אחת. כל איחול בא מהכלי
   get_blessing, ואתה מקריא את השדה text מילה במילה — בלי להוסיף, בלי לקצר
   ובלי לנסח מחדש. אם המתקשר מבקש איחול לאירוע שאין במערכת, אמור לו אילו
   אירועים קיימים. מותר לומר "מזל טוב" או "בהצלחה" כנימוס קצר, אבל איחול
   מנוסח — רק מהכלי.

אם המתקשר מבקש נציג אנושי: אמור שאתה מעביר, ומיד קרא ל-transfer_to_agent.
אם השיחה הסתיימה: אמור שלום וקרא ל-end_call.
בצע מיד ואל תבקש אישורים מיותרים.`;

export const config = {
  mode,

  server: {
    port: num('PORT', 8080),
    host: str('HOST', '0.0.0.0'),
    path: str('WS_PATH', '/voice'),
    /** The PBX sends this as `Authorization: Bearer <secret>` on every connect. */
    authSecret: str('AUTH_SECRET'),
    /** Set both to terminate TLS here instead of behind nginx. */
    tlsCertPath: process.env.TLS_CERT_PATH?.trim() || null,
    tlsKeyPath: process.env.TLS_KEY_PATH?.trim() || null,
    maxCallSeconds: num('MAX_CALL_SECONDS', 900),
  },

  /** Telephony side. Fixed by the PBX: raw PCM, 16-bit LE, mono, 8 kHz. */
  pbx: {
    sampleRate: 8000,
    frameMs: num('FRAME_MS', 20),
    /** The PBX drains queued audio for up to 6s after a final command. */
    finalDrainMs: num('FINAL_DRAIN_MS', 8000),
    /** Warn when our own outbound queue grows past this. */
    queueWarnMs: num('QUEUE_WARN_MS', 15000),
  },

  gemini: {
    apiKey: mode === 'bot' ? str('GEMINI_API_KEY') : (process.env.GEMINI_API_KEY ?? ''),
    model: str('GEMINI_MODEL', 'gemini-2.5-flash-native-audio-preview-09-2025'),
    voice: str('GEMINI_VOICE', 'Aoede'),
    /** Native-audio models reject an explicit code (he-IL included) and detect the language themselves. */
    languageCode: process.env.GEMINI_LANGUAGE?.trim() || null,
    temperature: num('GEMINI_TEMPERATURE', 0.7),
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    systemPrompt: systemPrompt(),
    /** Spoken first — a voice model waits in silence, the caller waits too. */
    greeting: str('GREETING', 'שלום, הגעת למענה הממוחשב של טכנוליין. איך אפשר לעזור?'),
    transcripts: bool('GEMINI_TRANSCRIPTS', true),
    /** null = leave Gemini's own defaults alone. */
    vadSilenceMs: process.env.VAD_SILENCE_MS ? num('VAD_SILENCE_MS', 700) : null,
    vadPrefixPaddingMs: process.env.VAD_PREFIX_PADDING_MS ? num('VAD_PREFIX_PADDING_MS', 300) : null,
  },

  audio: {
    /** Below this, a frame counts as room noise rather than speech. */
    speechThresholdDbfs: num('SPEECH_THRESHOLD_DBFS', -45),
    /** Frames above threshold needed before we call it speech. */
    speechOnsetFrames: num('SPEECH_ONSET_FRAMES', 3),
    /** Keep forwarding this long after speech stops, so Gemini's VAD sees the tail. */
    speechHangoverMs: num('SPEECH_HANGOVER_MS', 1500),
    /** Don't ship pure silence to the model — it is billed as input audio. */
    suppressSilence: bool('SUPPRESS_SILENCE', true),
    /** Only honour Gemini's `interrupted` when the caller really is talking. */
    gateBargeIn: bool('GATE_BARGE_IN', true),
  },

  tools: {
    defaultTimeoutMs: num('TOOL_TIMEOUT_MS', 4000),
    agentExtension: str('AGENT_EXTENSION', '/2'),
    /** Demo lookups (orders, balance, branches) return made-up data; off for a real deployment. */
    demo: bool('DEMO_TOOLS', true),
  },

  blessings: {
    /** Defaults to data/blessings.json next to the package. */
    file: process.env.BLESSINGS_FILE?.trim() || null,
    /** Check the bot's own transcript against what the catalogue served. */
    audit: bool('BLESSING_AUDIT', true),
    /** Log findings at error level instead of warn, for alerting. */
    auditStrict: bool('BLESSING_AUDIT_STRICT', false),
  },

  /** Per-call wav dumps (in/out at 8 kHz) for debugging. Off unless set. */
  recordDir: process.env.RECORD_DIR?.trim() || null,

  /**
   * Request reports by email over SMTP, off unless EMAIL_HOST is set. Each
   * report goes to its owner's notify address; EMAIL_TO is the fallback.
   */
  email: {
    host: process.env.EMAIL_HOST?.trim() || null,
    port: num('EMAIL_PORT', 587),
    /** true = TLS from the first byte (465); false = STARTTLS upgrade (587). */
    secure: bool('EMAIL_SECURE', false),
    user: process.env.EMAIL_USER?.trim() || null,
    pass: process.env.EMAIL_PASS?.trim() || null,
    from: process.env.EMAIL_FROM?.trim() || process.env.EMAIL_USER?.trim() || null,
    to: process.env.EMAIL_TO?.trim() || null,
    replyTo: process.env.EMAIL_REPLY_TO?.trim() || null,
  },

  /** Management web app: users, contacts, per-user instructions, request history. */
  app: {
    dbPath: str('DB_PATH', './db/ai-straem.sqlite'),
    /** Creates the first admin on an empty database; ignored once any user exists. */
    adminEmail: process.env.ADMIN_EMAIL?.trim() || null,
    adminPassword: process.env.ADMIN_PASSWORD?.trim() || null,
    /** Session cookies are Secure unless this is false (plain-http local testing). */
    secureCookies: bool('SECURE_COOKIES', true),
  },
} as const;

export type Config = typeof config;
