import { Type } from '@google/genai';
import { z } from 'zod';
import { evaluateExpression, ExpressionError, formatForSpeech } from './expression.js';
import type { ToolDefinition } from './registry.js';

/**
 * Arithmetic, done here rather than in the model's head.
 *
 * A voice model will happily assert that 1250 times 1.18 is 1465 and sound
 * completely certain about it. The system prompt forbids computing mentally;
 * this is where the number actually comes from, and every call lands in the log
 * with its expression and its result.
 */
export const calculatorTool: ToolDefinition<{ expression: string; precision?: number }> = {
  name: 'calculate',
  description:
    'מחשבון. חובה להשתמש בו לכל חישוב מספרי, גם לחישוב שנראה פשוט — אל תחשב בעצמך. ' +
    'תומך בחיבור, חיסור, כפל, חילוק, חזקה (^) וסוגריים. ' +
    'אחוזים מבוטאים בכפל: שמונה עשר אחוז מ-1250 הוא 1250*0.18, ותוספת של 18 אחוז היא 1250*1.18.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      expression: {
        type: Type.STRING,
        description: 'הביטוי החשבוני בספרות ובסימנים, למשל "1250*1.18" או "(90+60)/2". בלי מילים בעברית.',
      },
      precision: {
        type: Type.NUMBER,
        description: 'מספר ספרות אחרי הנקודה בתשובה המדוברת. ברירת מחדל 2.',
      },
    },
    required: ['expression'],
  },
  input: z.object({
    expression: z.string().trim().min(1).max(200),
    precision: z.number().int().min(0).max(8).optional(),
  }),
  handler: (args, ctx) => {
    try {
      const { normalized, value } = evaluateExpression(args.expression);
      const spoken = formatForSpeech(value, args.precision ?? 2);
      ctx.log.info(
        { expression: args.expression, normalized, value, spoken },
        'calculator evaluated an expression',
      );
      return {
        expression: args.expression,
        normalized,
        result: value,
        spoken,
        instruction: 'אמור את הערך של spoken. אל תחשב מחדש ואל תעגל אחרת.',
      };
    } catch (err) {
      if (err instanceof ExpressionError) {
        ctx.log.warn({ expression: args.expression, reason: err.message }, 'calculator rejected an expression');
        return {
          ok: false,
          error: err.message,
          ...(err.hint ? { hint: err.hint } : {}),
          instruction: 'תקן את הביטוי וקרא לכלי שוב. אל תחשב בעצמך.',
        };
      }
      throw err;
    }
  },
};
