import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Type } from '@google/genai';
import { z } from 'zod';
import type { ToolDefinition } from './registry.js';

/**
 * The blessing catalogue: the only place a blessing the bot speaks may come
 * from. Edit `data/blessings.json` and restart; nothing here is hard-coded.
 *
 * `get_blessing` returns one entry verbatim, together with its id, and reports
 * each one it hands out so the audit can later check the bot's own transcript
 * against what it was actually given.
 */

export interface Blessing {
  id: string;
  occasionId: string;
  occasionLabel: string;
  text: string;
}

export interface Occasion {
  id: string;
  label: string;
  aliases: string[];
  blessings: Blessing[];
}

interface RawCatalog {
  occasions: Array<{ id: string; label: string; aliases?: string[]; blessings: string[] }>;
}

export class BlessingCatalog {
  readonly occasions: Occasion[];
  private readonly byKey = new Map<string, Occasion>();

  constructor(raw: RawCatalog) {
    if (!Array.isArray(raw.occasions) || raw.occasions.length === 0) {
      throw new Error('blessings catalogue has no occasions');
    }
    this.occasions = raw.occasions.map((o) => {
      if (!o.id || !o.label || !Array.isArray(o.blessings) || o.blessings.length === 0) {
        throw new Error(`blessings catalogue entry is incomplete: ${JSON.stringify(o)}`);
      }
      return {
        id: o.id,
        label: o.label,
        aliases: o.aliases ?? [],
        // Ids are positional, so they stay stable as long as the list order does.
        blessings: o.blessings.map((text, i) => ({
          id: `${o.id}-${i + 1}`,
          occasionId: o.id,
          occasionLabel: o.label,
          text: text.trim(),
        })),
      };
    });

    for (const occ of this.occasions) {
      for (const key of [occ.id, occ.label, ...occ.aliases]) {
        this.byKey.set(normalizeKey(key), occ);
      }
    }
  }

  static load(path?: string): BlessingCatalog {
    const file = path ?? fileURLToPath(new URL('../../data/blessings.json', import.meta.url));
    return new BlessingCatalog(JSON.parse(readFileSync(file, 'utf8')) as RawCatalog);
  }

  /** Tolerant lookup: the model may send the id, the Hebrew label, or an alias. */
  find(occasion: string): Occasion | null {
    const key = normalizeKey(occasion);
    const exact = this.byKey.get(key);
    if (exact) return exact;
    // Fall back to containment, so "חתונה של אחי" still resolves.
    for (const [candidate, occ] of this.byKey) {
      if (candidate.length >= 3 && key.includes(candidate)) return occ;
    }
    return null;
  }

  get all(): Blessing[] {
    return this.occasions.flatMap((o) => o.blessings);
  }
}

function normalizeKey(s: string): string {
  return s
    .replace(/[֑-ׇ]/g, '') // niqqud and cantillation
    .replace(/[-־'"`.,!?]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface BlessingToolOptions {
  catalog: BlessingCatalog;
  /** Called for every blessing handed to the model, for the audit trail. */
  onServed?: (blessing: Blessing) => void;
}

export function blessingTools(opts: BlessingToolOptions): ToolDefinition<never>[] {
  const { catalog, onServed } = opts;
  const occasionList = catalog.occasions.map((o) => `${o.id} (${o.label})`).join(', ');

  const listOccasions: ToolDefinition<Record<string, never>> = {
    name: 'list_blessing_occasions',
    description:
      'רשימת האירועים שיש להם איחולים במערכת. השתמש כשהמתקשר שואל מה אפשר לאחל, או כשלא ברור לאיזה אירוע הוא מתכוון.',
    parameters: { type: Type.OBJECT, properties: {} },
    input: z.object({}),
    handler: () => ({
      occasions: catalog.occasions.map((o) => ({ id: o.id, label: o.label, count: o.blessings.length })),
    }),
  };

  const getBlessing: ToolDefinition<{ occasion: string; variant?: number }> = {
    name: 'get_blessing',
    description:
      `איחול מתוך קטלוג האיחולים של המערכת, לפי סוג האירוע. האירועים הקיימים: ${occasionList}. ` +
      'חובה להשתמש בכלי הזה לכל איחול. אסור לנסח איחול בעצמך — הקרא את הטקסט שחוזר מילה במילה, בלי לשנות, להוסיף או לקצר. ' +
      'מותר לפנות למתקשר בשמו לפני האיחול, אבל האיחול עצמו נאמר בדיוק כפי שהתקבל.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        occasion: {
          type: Type.STRING,
          description: `סוג האירוע. אפשר במזהה באנגלית או בעברית. אפשרויות: ${occasionList}`,
        },
        variant: {
          type: Type.NUMBER,
          description: 'מספר הנוסח, מ-1 ומעלה. השתמש כדי לקבל נוסח אחר אם המתקשר מבקש משהו שונה.',
        },
      },
      required: ['occasion'],
    },
    input: z.object({
      occasion: z.string().trim().min(2).max(60),
      variant: z.number().int().min(1).max(50).optional(),
    }),
    handler: (args, ctx) => {
      const occasion = catalog.find(args.occasion);
      if (!occasion) {
        ctx.log.warn({ requested: args.occasion }, 'no blessing occasion matched');
        return {
          found: false,
          message: `אין איחולים לאירוע "${args.occasion}" במערכת`,
          available: catalog.occasions.map((o) => o.label),
          instruction: 'אמור למתקשר אילו אירועים קיימים. אל תנסח איחול בעצמך.',
        };
      }

      const index = ((args.variant ?? 1) - 1) % occasion.blessings.length;
      const blessing = occasion.blessings[index]!;
      onServed?.(blessing);
      ctx.log.info(
        { blessingId: blessing.id, occasion: occasion.id, variant: index + 1 },
        'blessing served from catalogue',
      );

      return {
        found: true,
        occasion: occasion.id,
        occasion_label: occasion.label,
        blessing_id: blessing.id,
        text: blessing.text,
        variants_available: occasion.blessings.length,
        instruction: 'הקרא את השדה text מילה במילה, בלי שינוי. אל תוסיף איחול משלך.',
      };
    },
  };

  return [listOccasions, getBlessing] as unknown as ToolDefinition<never>[];
}
