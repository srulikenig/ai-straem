/**
 * A small arithmetic evaluator for the calculator tool.
 *
 * Hand-written rather than `eval`/`Function`: the input is a string a language
 * model produced from something a stranger said on the phone, so it is never
 * handed to a JavaScript parser. This grammar can only produce a number.
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/') unary)*
 *   unary   := ('-' | '+') unary | power
 *   power   := primary ('^' unary)?        // right associative
 *   primary := NUMBER | '(' expr ')'
 */

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

const MAX_LENGTH = 200;

/**
 * Speech-to-text and models produce typographic variants; fold them to ASCII
 * before parsing so "1,250 × 1.18" is not a syntax error.
 */
export function normalizeExpression(raw: string): string {
  return raw
    .replace(/[‎‏‪-‮]/g, '') // bidi marks
    .replace(/[×xX*]/g, '*')
    .replace(/[÷:]/g, '/')
    .replace(/[−–—]/g, '-') // minus sign, en/em dash
    .replace(/[＋]/g, '+')
    .replace(/,/g, '') // thousands separators
    .replace(/\s+/g, ' ')
    .trim();
}

type Token = { kind: 'num'; value: number } | { kind: 'op'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ') {
      i++;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < input.length && /[0-9]/.test(input[j]!)) j++;
      if (input[j] === '.') {
        j++;
        while (j < input.length && /[0-9]/.test(input[j]!)) j++;
      }
      tokens.push({ kind: 'num', value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (ch === '.') {
      let j = i + 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j++;
      if (j === i + 1) throw new ExpressionError(`לא ניתן לפרסר: "${ch}"`);
      tokens.push({ kind: 'num', value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if ('+-*/^()'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i++;
      continue;
    }
    if (ch === '%') {
      throw new ExpressionError(
        'הסימן % אינו נתמך',
        'בטא אחוזים בכפל: 18 אחוז מ-1250 הוא 1250*0.18',
      );
    }
    throw new ExpressionError(`תו לא חוקי בביטוי: "${ch}"`);
  }
  return tokens;
}

export interface EvaluatedExpression {
  normalized: string;
  value: number;
}

export function evaluateExpression(raw: string): EvaluatedExpression {
  const normalized = normalizeExpression(raw);
  if (normalized.length === 0) throw new ExpressionError('הביטוי ריק');
  if (normalized.length > MAX_LENGTH) throw new ExpressionError(`הביטוי ארוך מ-${MAX_LENGTH} תווים`);

  const tokens = tokenize(normalized);
  if (tokens.length === 0) throw new ExpressionError('הביטוי ריק');

  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const eatOp = (value: string): boolean => {
    const t = peek();
    if (t?.kind === 'op' && t.value === value) {
      pos++;
      return true;
    }
    return false;
  };

  function parseExpr(): number {
    let left = parseTerm();
    for (;;) {
      if (eatOp('+')) left += parseTerm();
      else if (eatOp('-')) left -= parseTerm();
      else return left;
    }
  }

  function parseTerm(): number {
    let left = parseUnary();
    for (;;) {
      if (eatOp('*')) left *= parseUnary();
      else if (eatOp('/')) {
        const divisor = parseUnary();
        if (divisor === 0) throw new ExpressionError('חילוק באפס');
        left /= divisor;
      } else return left;
    }
  }

  function parseUnary(): number {
    if (eatOp('-')) return -parseUnary();
    if (eatOp('+')) return parseUnary();
    return parsePower();
  }

  function parsePower(): number {
    const base = parsePrimary();
    // Right associative, and the exponent may itself be negative.
    if (eatOp('^')) {
      const exponent = parseUnary();
      const result = base ** exponent;
      if (!Number.isFinite(result)) throw new ExpressionError('התוצאה גדולה מדי');
      return result;
    }
    return base;
  }

  function parsePrimary(): number {
    const t = peek();
    if (!t) throw new ExpressionError('הביטוי נגמר באמצע');
    if (t.kind === 'num') {
      pos++;
      return t.value;
    }
    if (t.value === '(') {
      pos++;
      const inner = parseExpr();
      if (!eatOp(')')) throw new ExpressionError('חסר סוגר סוגר');
      return inner;
    }
    throw new ExpressionError(`לא צפוי: "${t.value}"`);
  }

  const value = parseExpr();
  if (pos !== tokens.length) {
    const rest = tokens[pos]!;
    throw new ExpressionError(`לא צפוי: "${rest.kind === 'num' ? rest.value : rest.value}"`);
  }
  if (!Number.isFinite(value)) throw new ExpressionError('התוצאה אינה מספר תקין');
  return { normalized, value };
}

/**
 * A number the model can read aloud without tripping: no exponent notation, no
 * fifteen trailing decimals from binary floating point.
 */
export function formatForSpeech(value: number, precision = 4): string {
  if (Number.isInteger(value)) return String(value);
  const rounded = Number(value.toFixed(precision));
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded);
}
