import { Type } from '@google/genai';
import { z } from 'zod';
import type { ToolDefinition } from './registry.js';
import {
  addDays,
  BRANCHES,
  BUSINESS_HOURS,
  COURIERS,
  hash,
  israelNow,
  ORDER_STATUSES,
  PLANS,
  pickFrom,
} from './demoData.js';

/**
 * Placeholder tools that return data, so the whole loop can be exercised before
 * any real system is wired in. Replace the handlers; keep the shapes.
 *
 * Two things they demonstrate on purpose:
 * - `check_balance` falls back to the caller's own number from the PBX `start`
 *   message, which is the kind of context a phone bot should never ask for.
 * - `slow_lookup` is deliberately slow, so the timeout path and the way silence
 *   feels on a live call can be heard rather than imagined.
 */

export const getCurrentTime: ToolDefinition<Record<string, never>> = {
  name: 'get_current_time',
  description: 'השעה והתאריך הנוכחיים בישראל. השתמש כשהמתקשר שואל מה השעה או מה התאריך היום.',
  parameters: { type: Type.OBJECT, properties: {} },
  input: z.object({}),
  handler: () => {
    const { date, time, weekday } = israelNow();
    return { date, time, weekday, timezone: 'Asia/Jerusalem' };
  },
};

const getBusinessHours: ToolDefinition<{ day?: string }> = {
  name: 'get_business_hours',
  description: 'שעות הפעילות של המוקד. השתמש כשהמתקשר שואל מתי פתוח, או אם אנחנו פתוחים עכשיו.',
  parameters: {
    type: Type.OBJECT,
    properties: { day: { type: Type.STRING, description: 'יום בשבוע בעברית, למשל "שלישי". אם חסר — היום הנוכחי.' } },
  },
  input: z.object({ day: z.string().max(20).optional() }),
  handler: (args) => {
    const now = israelNow();
    const row = args.day
      ? BUSINESS_HOURS.find((h) => h.day === args.day!.replace(/^יום\s+/, '').trim())
      : BUSINESS_HOURS[now.index];
    if (!row) return { found: false, message: `לא מזוהה יום בשם ${args.day}` };

    const openNow =
      !args.day && row.open !== null && row.close !== null && now.time >= row.open && now.time < row.close;
    return {
      found: true,
      day: row.day,
      closed_all_day: row.open === null,
      opens_at: row.open,
      closes_at: row.close,
      ...(args.day ? {} : { open_now: openNow, current_time: now.time }),
    };
  },
};

const getOrderStatus: ToolDefinition<{ order_id: string }> = {
  name: 'get_order_status',
  description: 'סטטוס הזמנה לפי מספר הזמנה. אמור למתקשר משפט קצר כמו "רגע, בודק" לפני הקריאה.',
  parameters: {
    type: Type.OBJECT,
    properties: { order_id: { type: Type.STRING, description: 'מספר ההזמנה כפי שנמסר, ספרות ואותיות' } },
    required: ['order_id'],
  },
  input: z.object({ order_id: z.string().trim().min(3).max(32) }),
  timeoutMs: 5000,
  handler: async (args) => {
    await delay(120 + (hash(args.order_id) % 300)); // pretend it is a database
    const status = pickFrom(args.order_id, ORDER_STATUSES);
    return {
      order_id: args.order_id,
      status: status.code,
      status_hebrew: status.he,
      courier: status.code === 'processing' ? null : pickFrom(args.order_id, COURIERS, 'courier'),
      items: 1 + (hash(args.order_id + 'items') % 4),
      expected_arrival: status.daysToArrive >= 0 ? addDays(status.daysToArrive) : null,
      delivered_on: status.code === 'delivered' ? addDays(-2) : null,
    };
  },
};

const checkBalance: ToolDefinition<{ phone_number?: string }> = {
  name: 'check_balance',
  description:
    'יתרת החשבון והמסלול של הלקוח. אם המתקשר לא מסר מספר, הכלי משתמש במספר שממנו הוא מתקשר — אל תשאל אותו למספר סתם.',
  parameters: {
    type: Type.OBJECT,
    properties: { phone_number: { type: Type.STRING, description: 'מספר טלפון, רק אם המתקשר מסר מספר אחר משלו' } },
  },
  input: z.object({ phone_number: z.string().regex(/^0\d{8,9}$/, 'מספר טלפון ישראלי לא תקין').optional() }),
  handler: async (args, ctx) => {
    const phone = args.phone_number ?? ctx.caller;
    if (!phone) return { found: false, message: 'אין מספר מזוהה — בקש מהמתקשר למסור מספר טלפון' };
    await delay(80);
    const h = hash(phone);
    return {
      found: true,
      phone_number: phone,
      used_caller_id: !args.phone_number,
      plan: pickFrom(phone, PLANS),
      balance_ils: Number(((h % 45_000) / 100).toFixed(2)),
      minutes_left: h % 600,
      renews_on: addDays(1 + (h % 28)),
    };
  },
};

const findBranch: ToolDefinition<{ city: string }> = {
  name: 'find_branch',
  description: 'פרטי הסניף בעיר מסוימת: כתובת, טלפון ושעות. השתמש כשהמתקשר שואל איפה יש סניף.',
  parameters: {
    type: Type.OBJECT,
    properties: { city: { type: Type.STRING, description: 'שם העיר בעברית' } },
    required: ['city'],
  },
  input: z.object({ city: z.string().trim().min(2).max(40) }),
  handler: (args) => {
    const city = args.city.trim();
    const exact = BRANCHES.find((b) => b.city === city || city.includes(b.city));
    if (exact) return { found: true, ...exact };
    return {
      found: false,
      message: `אין סניף ב${city}`,
      nearest_cities: BRANCHES.map((b) => b.city),
    };
  },
};

const slowLookup: ToolDefinition<{ seconds: number }> = {
  name: 'slow_lookup',
  description:
    'כלי בדיקה בלבד: ממתין מספר שניות ואז מחזיר תשובה. משמש כדי לבדוק איך השיחה מתנהגת כשכלי לוקח זמן.',
  parameters: {
    type: Type.OBJECT,
    properties: { seconds: { type: Type.NUMBER, description: 'כמה שניות להמתין, בין 0 ל-30' } },
    required: ['seconds'],
  },
  input: z.object({ seconds: z.number().min(0).max(30) }),
  // Left on the default timeout on purpose: ask for 10 seconds and hear the
  // timeout path work instead of the call hanging.
  handler: async (args) => {
    await delay(args.seconds * 1000);
    return { waited_seconds: args.seconds, message: 'ההמתנה הסתיימה' };
  },
};

export const demoTools = [
  getCurrentTime,
  getBusinessHours,
  getOrderStatus,
  checkBalance,
  findBranch,
  slowLookup,
] as unknown as ToolDefinition<never>[];

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
