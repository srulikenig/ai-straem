import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import type { Logger } from '../logger.js';

export interface TranscriptTurn {
  role: 'caller' | 'bot';
  text: string;
}

/** One call, boiled down to what the person it was for needs to act on it. */
export interface RequestReport {
  caller: string | null;
  callId: string | null;
  startedAt: Date;
  durationMs: number;
  /** What the bot saved with save_answer. */
  answers: Record<string, string>;
  transcript: TranscriptTurn[];
  /** The mixed recording, or null when recording is off. */
  recording: string | null;
}

/** The fields the prompt asks for, in the order a reader wants them. */
const LABELS: Record<string, string> = {
  caller_name: 'שם',
  request: 'הפנייה',
  urgency: 'דחיפות',
  callback_time: 'זמן נוח לחזור',
  callback_phone: 'טלפון לחזרה',
};

export function formatReport(r: RequestReport): string {
  const when = r.startedAt.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const seconds = Math.round(r.durationMs / 1000);
  const known = Object.keys(LABELS).filter((k) => r.answers[k]);
  const other = Object.keys(r.answers).filter((k) => !(k in LABELS));

  const lines = [
    `פנייה חדשה מ-${r.caller ?? 'מספר חסוי'}`,
    `${when} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} דקות`,
    '',
    ...known.map((k) => `${LABELS[k]}: ${r.answers[k]}`),
    ...other.map((k) => `${k}: ${r.answers[k]}`),
    ...(known.length + other.length === 0 ? ['(הבוט לא שמר פרטים — ראה תמלול)'] : []),
    '',
    'תמלול:',
    ...r.transcript.map((t) => `${t.role === 'caller' ? 'מתקשר' : 'בוט'}: ${t.text.trim()}`),
  ];
  return lines.join('\n');
}

export function reportSubject(r: RequestReport): string {
  const who = r.answers['caller_name'] ?? r.caller ?? 'מספר חסוי';
  const what = r.answers['request'];
  const urgent = r.answers['urgency']?.includes('דחוף') && !r.answers['urgency'].includes('לא') ? 'דחוף · ' : '';
  return `${urgent}פנייה מ${who}${what ? `: ${what.length > 60 ? `${what.slice(0, 60)}…` : what}` : ''}`;
}

/** A call where the caller never spoke and nothing was saved is not a request. */
export function hasRequest(r: RequestReport): boolean {
  return Object.keys(r.answers).length > 0 || r.transcript.some((t) => t.role === 'caller' && t.text.trim());
}

/**
 * Hands a finished call's request on: always to the log, to report.txt beside
 * the recording when recording is on, and by email when SMTP is configured.
 */
export async function deliverReport(r: RequestReport, recordingDir: string | null, log: Logger): Promise<void> {
  if (!hasRequest(r)) {
    log.info('no request in this call; nothing to deliver');
    return;
  }
  const text = formatReport(r);
  log.info({ report: text, answers: r.answers, recording: r.recording }, 'request report');
  if (recordingDir) {
    try {
      await writeFile(join(recordingDir, 'report.txt'), text);
    } catch (err) {
      log.error({ err }, 'failed to write the request report');
    }
  }
  if (config.email.host && config.email.to) await emailReport(r, text, log);
}

let transport: Transporter | null = null;

async function emailReport(r: RequestReport, text: string, log: Logger): Promise<void> {
  const e = config.email;
  transport ??= nodemailer.createTransport({
    host: e.host!,
    port: e.port,
    secure: e.secure,
    ...(e.user && e.pass ? { auth: { user: e.user, pass: e.pass } } : {}),
  });
  const html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  try {
    const info = await transport.sendMail({
      from: e.from ?? undefined,
      to: e.to!,
      ...(e.replyTo ? { replyTo: e.replyTo } : {}),
      subject: reportSubject(r),
      text,
      // Plain text renders left-to-right in most clients; Hebrew needs dir=rtl.
      html: `<div dir="rtl" style="white-space:pre-wrap;font-family:Arial,sans-serif">${html}</div>`,
      attachments: r.recording ? [{ filename: 'call.wav', path: r.recording }] : [],
    });
    log.info({ messageId: info.messageId, to: e.to }, 'request report emailed');
  } catch (err) {
    log.error({ err }, 'failed to email the request report');
  }
}
