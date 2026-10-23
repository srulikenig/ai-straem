import type { Logger } from '../logger.js';
import type { Blessing } from '../tools/blessings.js';

/**
 * Checks what the bot actually said against what the catalogue gave it.
 *
 * Be clear about what this can and cannot do. A language model cannot be
 * *prevented* from improvising a blessing — the system prompt and the tool's
 * own instruction field make it unlikely, not impossible. What this class does
 * is make every occurrence visible: it reads the model's own output
 * transcription, and whenever a turn contains blessing language that does not
 * trace back to a blessing the tool served, it logs a finding with the exact
 * sentence. So the claim "blessings only ever come through the tool" stops
 * being a hope and becomes something you can grep for.
 */

export interface AuditFinding {
  sentence: string;
  marker: string;
}

export interface BlessingAuditOptions {
  log: Logger;
  /** Also log findings at error level, for alerting. */
  strict: boolean;
  /** A strong marker only counts inside a clause at least this long. */
  minWords?: number;
}

/**
 * Phrases that only appear when someone is composing a blessing. A bare
 * courtesy ("בהצלחה!") is not one of these — see COURTESY_MARKERS.
 */
const BLESSING_MARKERS = [
  'יהי רצון',
  'שתזכה',
  'שתזכי',
  'שתזכו',
  'תזכה',
  'תזכי',
  'תזכו',
  'מאחל',
  'מאחלת',
  'מאחלים',
  'רפואה שלמה',
  'אריכות ימים',
  'בשורות טובות',
  'לשנים רבות',
  'בשעה טובה',
  'המקום ינחם',
  'משתתפים בצערכם',
];

/**
 * Short social phrases. Legitimate on their own in a sign-off, so they are
 * counted and reported but never treated as an improvised blessing.
 */
const COURTESY_MARKERS = ['מזל טוב', 'בהצלחה', 'כל טוב', 'חג שמח', 'שבת שלום'];

export class BlessingAudit {
  private readonly served: Blessing[] = [];
  private readonly servedWords: Set<string>[] = [];
  private readonly findings: AuditFinding[] = [];
  private courtesies = 0;
  private readonly minWords: number;

  constructor(private readonly opts: BlessingAuditOptions) {
    this.minWords = opts.minWords ?? 4;
  }

  /** Called by the blessing tool for every entry it hands to the model. */
  recordServed(blessing: Blessing): void {
    this.served.push(blessing);
    this.servedWords.push(contentWords(blessing.text));
  }

  /**
   * Called once per completed bot turn, with the model's output transcription.
   * Returns the findings for this turn.
   */
  checkTurn(transcript: string): AuditFinding[] {
    const found: AuditFinding[] = [];

    for (const sentence of splitSentences(transcript)) {
      const marker = BLESSING_MARKERS.find((m) => normalize(sentence).includes(m));
      if (marker) {
        const words = contentWords(sentence);
        if (words.size < this.minWords) continue; // too short to be a composed blessing
        if (this.tracesToCatalogue(words)) continue;
        const finding: AuditFinding = { sentence: sentence.trim(), marker };
        found.push(finding);
        this.findings.push(finding);
        const payload = { marker, sentence: finding.sentence, servedSoFar: this.served.map((b) => b.id) };
        if (this.opts.strict) {
          this.opts.log.error(payload, 'BLESSING NOT FROM CATALOGUE');
        } else {
          this.opts.log.warn(payload, 'blessing not from catalogue');
        }
        continue;
      }
      const courtesy = COURTESY_MARKERS.find((m) => normalize(sentence).includes(m));
      if (courtesy) {
        this.courtesies++;
        this.opts.log.debug({ courtesy, sentence: sentence.trim() }, 'courtesy phrase (not a catalogue blessing)');
      }
    }
    return found;
  }

  /**
   * A sentence traces to the catalogue when most of its content words appear in
   * a blessing that was actually served. Exact matching would be too brittle:
   * the output transcription is not character-identical to the source text.
   */
  private tracesToCatalogue(sentenceWords: Set<string>): boolean {
    if (sentenceWords.size === 0) return true;
    for (const words of this.servedWords) {
      let hits = 0;
      for (const w of sentenceWords) if (words.has(w)) hits++;
      if (hits / sentenceWords.size >= 0.5) return true;
    }
    return false;
  }

  get summary(): {
    blessingsServed: number;
    blessingIds: string[];
    improvisedBlessings: number;
    courtesyPhrases: number;
    clean: boolean;
  } {
    return {
      blessingsServed: this.served.length,
      blessingIds: this.served.map((b) => b.id),
      improvisedBlessings: this.findings.length,
      courtesyPhrases: this.courtesies,
      clean: this.findings.length === 0,
    };
  }

  /** One line per call, so a whole day can be checked with a single grep. */
  logSummary(): void {
    const s = this.summary;
    if (s.clean) {
      this.opts.log.info(s, 'blessing audit: clean — every blessing came from the catalogue');
    } else {
      this.opts.log.error(s, 'blessing audit: FOUND blessings outside the catalogue');
    }
  }
}

function normalize(s: string): string {
  return s
    .replace(/[֑-ׇ]/g, '') // niqqud
    .replace(/[‎‏]/g, '')
    .replace(/[-־"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSentences(s: string): string[] {
  return normalize(s)
    .split(/[.!?\n]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function contentWords(s: string): Set<string> {
  return new Set(
    normalize(s)
      .split(/[\s,:;()]+/)
      .map((w) => w.replace(/[^֐-׿\w]/g, ''))
      .filter((w) => w.length >= 3),
  );
}
