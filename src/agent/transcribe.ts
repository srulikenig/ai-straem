import { readFile } from 'node:fs/promises';
import { GoogleGenAI, Type } from '@google/genai';
import { z } from 'zod';
import { config } from '../config.js';
import type { Logger } from '../logger.js';
import type { TranscriptTurn } from '../db.js';

const TIMEOUT_MS = 60_000;

const turnsSchema = z.array(z.object({ role: z.enum(['caller', 'bot']), text: z.string() })).min(1);

/** Accepts the model's JSON only if it is a non-empty list of well-formed turns. */
export function parseTurns(json: string | undefined): TranscriptTurn[] | null {
  if (!json) return null;
  try {
    const r = turnsSchema.safeParse(JSON.parse(json));
    if (!r.success) return null;
    const turns = r.data.map((t) => ({ role: t.role, text: t.text.trim() })).filter((t) => t.text);
    return turns.length ? turns : null;
  } catch {
    return null;
  }
}

/**
 * Transcribes the finished call from its recording (both sides, as heard).
 *
 * The bot's own lines are already known exactly from the live session, so they
 * are handed over as anchors: the model only has to place them and transcribe
 * the caller between them. Returns null on any failure, and the live
 * transcript stays.
 */
export async function transcribeCall(recording: string, live: TranscriptTurn[], log: Logger): Promise<TranscriptTurn[] | null> {
  const started = Date.now();
  try {
    const audio = await readFile(recording);
    const botLines = live.filter((t) => t.role === 'bot').map((t, i) => `${i + 1}. ${t.text.trim()}`);
    const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
    const res = await ai.models.generateContent({
      model: config.stt.model,
      contents: [
        {
          parts: [
            { inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } },
            {
              text: [
                'זו הקלטה של שיחת טלפון בעברית בין מענה טלפוני אוטומטי (bot) לבין מתקשר (caller).',
                'תמלל את כל השיחה לפי הסדר, תור אחרי תור.',
                'את דברי המתקשר תמלל מילה במילה, בעברית, בדיוק כפי שנאמרו — בלי לתקן, לסכם או להשלים. מילה שלא נשמעה בבירור: [לא ברור].',
                'אלה המשפטים שהמענה אמר, לפי הסדר — השתמש בהם בתורות של bot. משפט שנקטע ברשימה השלם מההקלטה:',
                ...botLines,
              ].join('\n'),
            },
          ],
        },
      ],
      config: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: { role: { type: Type.STRING, enum: ['caller', 'bot'] }, text: { type: Type.STRING } },
            required: ['role', 'text'],
          },
        },
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      },
    });
    const turns = parseTurns(res.text);
    if (!turns) {
      log.warn({ ms: Date.now() - started }, 'post-call transcription returned nothing usable; keeping the live transcript');
      return null;
    }
    log.info({ ms: Date.now() - started, turns: turns.length }, 'post-call transcription');
    return turns;
  } catch (err) {
    log.warn({ err, ms: Date.now() - started }, 'post-call transcription failed; keeping the live transcript');
    return null;
  }
}
