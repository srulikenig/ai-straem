import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

/** A call where the caller never spoke and nothing was saved is not a request. */
export function hasRequest(r: RequestReport): boolean {
  return Object.keys(r.answers).length > 0 || r.transcript.some((t) => t.role === 'caller' && t.text.trim());
}

/**
 * Hands a finished call's request on. For now that means the log and a
 * report.txt beside the recording; sending it by email plugs in here.
 */
export async function deliverReport(r: RequestReport, recordingDir: string | null, log: Logger): Promise<void> {
  if (!hasRequest(r)) {
    log.info('no request in this call; nothing to deliver');
    return;
  }
  const text = formatReport(r);
  log.info({ report: text, answers: r.answers, recording: r.recording }, 'request report');
  if (!recordingDir) return;
  try {
    await writeFile(join(recordingDir, 'report.txt'), text);
  } catch (err) {
    log.error({ err }, 'failed to write the request report');
  }
}
