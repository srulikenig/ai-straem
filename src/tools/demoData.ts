/**
 * Stand-in data for the demo tools.
 *
 * Everything is deterministic: the same order id always yields the same status,
 * so a test call is reproducible and a bug is never "the mock rolled a
 * different number this time". Swap these functions for real lookups later —
 * the tool definitions above them do not change.
 */

/** FNV-1a: small, stable, and enough to spread ids across the tables below. */
export function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function pickFrom<T>(input: string, list: readonly T[], salt = ''): T {
  return list[hash(input + salt) % list.length]!;
}

export const ORDER_STATUSES = [
  { code: 'processing', he: 'בהכנה במחסן', daysToArrive: 3 },
  { code: 'shipped', he: 'יצאה למשלוח', daysToArrive: 1 },
  { code: 'out_for_delivery', he: 'אצל השליח, מגיעה היום', daysToArrive: 0 },
  { code: 'delivered', he: 'נמסרה', daysToArrive: -1 },
  { code: 'delayed', he: 'מתעכבת בגלל חוסר במלאי', daysToArrive: 7 },
] as const;

export const COURIERS = ['שליחי הצפון', 'דואר ישראל', 'ציטי אקספרס'] as const;

export const BRANCHES = [
  { city: 'ירושלים', address: 'כנפי נשרים 12', phone: '025000000', hours: 'ראשון עד חמישי 9:00-19:00' },
  { city: 'תל אביב', address: 'הרצל 45', phone: '035000000', hours: 'ראשון עד חמישי 9:00-20:00' },
  { city: 'חיפה', address: 'הנמל 3', phone: '045000000', hours: 'ראשון עד חמישי 9:00-18:00' },
  { city: 'באר שבע', address: 'רגר 88', phone: '085000000', hours: 'ראשון עד חמישי 9:00-18:00' },
  { city: 'בני ברק', address: 'ז׳בוטינסקי 7', phone: '037000000', hours: 'ראשון עד חמישי 9:00-19:00' },
] as const;

export const PLANS = ['בסיסי', 'משפחתי', 'עסקי'] as const;

export const BUSINESS_HOURS = [
  { day: 'ראשון', open: '09:00', close: '18:00' },
  { day: 'שני', open: '09:00', close: '18:00' },
  { day: 'שלישי', open: '09:00', close: '18:00' },
  { day: 'רביעי', open: '09:00', close: '18:00' },
  { day: 'חמישי', open: '09:00', close: '14:00' },
  { day: 'שישי', open: null, close: null },
  { day: 'שבת', open: null, close: null },
] as const;

const IL_TZ = 'Asia/Jerusalem';

export function israelNow(now = new Date()): { date: string; time: string; weekday: string; index: number } {
  const date = new Intl.DateTimeFormat('he-IL', { timeZone: IL_TZ, dateStyle: 'short' }).format(now);
  const time = new Intl.DateTimeFormat('he-IL', { timeZone: IL_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const weekday = new Intl.DateTimeFormat('he-IL', { timeZone: IL_TZ, weekday: 'long' }).format(now);
  // Sunday = 0, matching BUSINESS_HOURS order.
  const en = new Intl.DateTimeFormat('en-US', { timeZone: IL_TZ, weekday: 'short' }).format(now);
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(en);
  return { date, time, weekday, index };
}

export function addDays(days: number, now = new Date()): string {
  const d = new Date(now.getTime() + days * 86_400_000);
  return new Intl.DateTimeFormat('he-IL', { timeZone: IL_TZ, dateStyle: 'short' }).format(d);
}
