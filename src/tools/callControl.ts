import { Type } from '@google/genai';
import { z } from 'zod';
import type { ToolDefinition } from './registry.js';

/**
 * Tools that act on the call itself rather than returning data.
 *
 * The transfer/hangup ones send a *final* command: the PBX drains up to six
 * seconds of queued audio and then acts, so the model should call them the
 * moment it starts its closing sentence, not after. Each still returns a
 * result, because a function call left unanswered leaves the model waiting for
 * a reply that will never come — mid-goodbye.
 */

export interface CallControlOptions {
  /** IVR extension path used when the model does not name one, e.g. "/2". */
  defaultAgentExtension: string;
}

export function callControlTools(opts: CallControlOptions): ToolDefinition<never>[] {
  const transferToAgent: ToolDefinition<{ extension?: string; reason?: string }> = {
    name: 'transfer_to_agent',
    description:
      'העברת השיחה לנציג אנושי בשלוחה במרכזייה. קרא לכלי מיד אחרי שאמרת למתקשר שאתה מעביר אותו, לא לפני ולא הרבה אחרי.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        extension: { type: Type.STRING, description: 'שלוחת היעד, למשל "/2". אם לא ידוע — אל תשלח.' },
        reason: { type: Type.STRING, description: 'סיבת ההעברה במשפט קצר, לתיעוד.' },
      },
    },
    input: z.object({ extension: z.string().min(1).max(32).optional(), reason: z.string().max(200).optional() }),
    handler: (args, ctx) => {
      const target = args.extension ?? opts.defaultAgentExtension;
      if (ctx.call.closing) return { transferred: false, message: 'השיחה כבר בתהליך סיום' };
      ctx.call.transferExtension(target);
      if (args.reason) ctx.call.saveAnswer('transfer_reason', args.reason);
      return { transferred: true, target, message: 'ההעברה בוצעה. סיים את המשפט הנוכחי ואל תתחיל נושא חדש.' };
    },
  };

  const transferToPhone: ToolDefinition<{ phone_number: string; reason?: string }> = {
    name: 'transfer_to_phone',
    description: 'העברת השיחה למספר טלפון חיצוני. השתמש רק כשהמתקשר ביקש מספר חיצוני מפורש.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        phone_number: { type: Type.STRING, description: 'מספר טלפון ישראלי, ספרות בלבד, למשל 0501234567' },
        reason: { type: Type.STRING, description: 'סיבת ההעברה במשפט קצר.' },
      },
      required: ['phone_number'],
    },
    input: z.object({
      phone_number: z.string().regex(/^0\d{8,9}$/, 'מספר טלפון ישראלי לא תקין'),
      reason: z.string().max(200).optional(),
    }),
    handler: (args, ctx) => {
      if (ctx.call.closing) return { transferred: false, message: 'השיחה כבר בתהליך סיום' };
      ctx.call.transferPhone(args.phone_number);
      if (args.reason) ctx.call.saveAnswer('transfer_reason', args.reason);
      return { transferred: true, target: args.phone_number, message: 'ההעברה בוצעה. סיים את המשפט הנוכחי.' };
    },
  };

  const endCall: ToolDefinition<{ reason?: string }> = {
    name: 'end_call',
    description:
      'סיום השיחה וניתוק. קרא לכלי רק אחרי שהמתקשר ענה על כל מה ששאלת ואמר שאין לו עוד מה להוסיף, ואחרי שאמרת משפט סיום. לעולם אל תקרא לו מיד אחרי ששאלת שאלה.',
    parameters: {
      type: Type.OBJECT,
      properties: { reason: { type: Type.STRING, description: 'סיבת הסיום במשפט קצר, לתיעוד.' } },
    },
    input: z.object({ reason: z.string().max(200).optional() }),
    // The goodbye is already said; a blocking reply made the model say it again.
    silent: true,
    handler: (args, ctx) => {
      if (ctx.call.closing) return { ended: false, message: 'השיחה כבר בתהליך סיום' };
      if (args.reason) ctx.call.saveAnswer('end_reason', args.reason);
      ctx.call.endCall();
      return { ended: true, message: 'הניתוק יבוצע אחרי שהמתקשר ישמע את המשפט האחרון.' };
    },
  };

  const saveAnswer: ToolDefinition<{ name: string; value: string }> = {
    name: 'save_answer',
    description:
      'שמירת פרט שנאסף מהמתקשר (שם, מספר הזמנה, כתובת, סיבת פנייה). הפרט מופיע בדוחות המרכזייה. שמור כל פרט חשוב מיד כשקיבלת אותו. השמירה שקטה: אחריה המשך את השיחה כרגיל.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: 'שם השדה באנגלית, למשל customer_name או order_id' },
        value: { type: Type.STRING, description: 'הערך כפי שנמסר' },
      },
      required: ['name', 'value'],
    },
    input: z.object({ name: z.string().min(1).max(64), value: z.string().min(1).max(500) }),
    // A blocking reply here made the model start a fresh turn right after asking
    // a question — and answer it itself, assuming the caller's reply, then hang up.
    silent: true,
    handler: (args, ctx) => {
      ctx.call.saveAnswer(args.name, args.value);
      return { saved: true, name: args.name };
    },
  };

  return [transferToAgent, transferToPhone, endCall, saveAnswer] as unknown as ToolDefinition<never>[];
}
