/**
 * Wire protocol for the PBX streaming channel.
 *
 * Binary frames are always audio (PCM16 LE mono 8 kHz); text frames are always
 * JSON with a `type` discriminator.
 *
 * The vendor docs name the message types and show one command verbatim
 * (`{"type":"transfer_extension","target":"/2"}`) but do not pin down the field
 * names inside `start`, `dtmf` or `save_answer`. So inbound parsing accepts any
 * of the plausible spellings and always keeps `raw` — one real test call, with
 * `LOG_LEVEL=debug`, reveals the true schema without a code change.
 */

export interface StartMessage {
  type: 'start';
  callId: string | null;
  caller: string | null;
  extension: string | null;
  raw: Record<string, unknown>;
}

export interface DtmfMessage {
  type: 'dtmf';
  digit: string;
  raw: Record<string, unknown>;
}

export interface HangupMessage {
  type: 'hangup';
  raw: Record<string, unknown>;
}

export interface UnknownMessage {
  type: 'unknown';
  raw: Record<string, unknown>;
}

export type InboundMessage = StartMessage | DtmfMessage | HangupMessage | UnknownMessage;

function pick(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

export function parseInbound(text: string): InboundMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const type = typeof obj['type'] === 'string' ? (obj['type'] as string).toLowerCase() : '';

  switch (type) {
    case 'start':
      return {
        type: 'start',
        callId: pick(obj, ['call_id', 'callId', 'callID', 'id', 'uuid', 'session_id', 'sessionId']),
        caller: pick(obj, ['caller', 'caller_id', 'callerId', 'from', 'phone', 'number', 'did', 'ani']),
        extension: pick(obj, ['extension', 'ext', 'to', 'destination', 'dnis']),
        raw: obj,
      };
    case 'dtmf':
      return { type: 'dtmf', digit: pick(obj, ['digit', 'digits', 'key', 'dtmf', 'value', 'tone']) ?? '', raw: obj };
    case 'hangup':
      return { type: 'hangup', raw: obj };
    default:
      return { type: 'unknown', raw: obj };
  }
}

/* ------------------------------- outbound -------------------------------- */

export interface OutboundCommand {
  type: string;
  [key: string]: unknown;
}

/** Drop whatever is still queued for playback — the caller started talking. */
export const clearCommand = (): OutboundCommand => ({ type: 'clear' });

/** Record a collected detail; it shows up in the PBX reports and Excel export. */
export const saveAnswerCommand = (name: string, value: string): OutboundCommand => ({
  type: 'save_answer',
  name,
  value,
});

/** Final. `target` is an IVR extension path, e.g. "/2". */
export const transferExtensionCommand = (target: string): OutboundCommand => ({
  type: 'transfer_extension',
  target,
});

/** Final. `target` is an external phone number. */
export const transferPhoneCommand = (target: string): OutboundCommand => ({
  type: 'transfer_phone',
  target,
});

/** Final. */
export const hangupCommand = (): OutboundCommand => ({ type: 'hangup' });

/**
 * Final commands end the stream: the PBX drains up to six seconds of queued
 * audio and then acts, so exactly one may be sent per call.
 */
const FINAL_TYPES = new Set(['transfer_extension', 'transfer_phone', 'hangup']);

export function isFinalCommand(cmd: OutboundCommand): boolean {
  return FINAL_TYPES.has(cmd.type);
}
