# ai-straem

גשר בין ערוץ סטרימינג של מרכזייה לבין מודל קולי (Gemini Live), עם קריאה לכלים
(function calling) תוך כדי שיחה.

המרכזייה מתחברת **אליך**: היא פותחת WebSocket אחד לכל שיחה, שולחת את קול המתקשר,
ומשמיעה לו בחזרה את מה שאתה שולח. השרת הזה יושב באמצע — ממיר קצבי דגימה, מזרים
אודיו לשני הכיוונים בקצב זמן אמת, ומתרגם החלטות של המודל לפקודות שיחה.

```
המתקשר ⇄ מרכזייה ──wss──► [ ai-straem ] ──wss──► Gemini Live
                            8k ⇄ 16k/24k
                            pacing · tools
```

## התחלה מהירה

```bash
npm install
cp .env.example .env      # ומלא AUTH_SECRET
npm test                  # 41 טסטים, בלי צורך במפתח API
```

### שלב 0 — echo, בלי מודל ובלי עלות

הדרך הזולה ביותר לוודא שהחיבור למרכזייה תקין. השרת מחזיר למתקשר את קולו שלו,
דרך אותו מנגנון pacing שהנתיב האמיתי משתמש בו.

```bash
MODE=echo npm run dev

# בטרמינל שני — מרכזייה מדומה, בלי צורך בטלפון:
npm run tone -- tmp/caller.wav
npm run mock -- --secret <AUTH_SECRET> --audio tmp/caller.wav --dtmf '7@3s' --hangup 12s
```

הסקריפט מדפיס כל פקודת JSON שהשרת שלח, ושומר את מה ששמע ב-`tmp/mock-bot-reply.wav`.

### שלב 1 — הבוט

```bash
# .env: MODE=bot, GEMINI_API_KEY=...
npm run dev
```

## מה בכל קובץ

| קובץ | תפקיד |
|---|---|
| `src/server.ts` | שרת WebSocket, אימות `Authorization: Bearer` בזמן ה-upgrade |
| `src/pbx/protocol.ts` | פענוח הודעות המרכזייה ובניית פקודות |
| `src/pbx/writer.ts` | **הכותב היחיד לסוקט** + קצב זמן אמת של 20ms |
| `src/pbx/session.ts` | שיחה אחת: מחזור חיים, פקודות סופיות, הקלטות |
| `src/audio/resample.ts` | resampler פוליפאזי עם סינון anti-alias |
| `src/audio/level.ts` | שער עוצמה: זיהוי barge-in וחיסכון בשקט |
| `src/gemini/liveClient.ts` | מפגש עם Gemini Live — **כל התלות במודל נמצאת כאן** |
| `src/tools/registry.ts` | רישום כלים, ולידציה, timeout, טיפול בשגיאות |
| `src/tools/callControl.ts` | כלים שפועלים על השיחה: העברה, ניתוק, שמירת פרט |
| `src/tools/expression.ts` | מפרסר חשבוני כתוב ביד — **לא** `eval` |
| `src/tools/calculator.ts` | הכלי `calculate` |
| `src/tools/blessings.ts` | טעינת קטלוג האיחולים והכלי `get_blessing` |
| `src/agent/blessingAudit.ts` | אימות שאיחולים באו מהקטלוג ולא מהמודל |
| `data/blessings.json` | **קטלוג האיחולים — ערוך אותו** |
| `src/tools/demo.ts` | כלי דמו שמחזירים מידע — להחלפה בלוגיקה אמיתית |
| `src/agent/bridge.ts` | מחבר את שלושתם |
| `scripts/mock-pbx.ts` | מרכזייה מדומה לבדיקות מקומיות |

## כלים

שני סוגים, ושונים מהותית:

**כלי מידע** מריצים פונקציה ומחזירים את התוצאה למודל, שממשיך לדבר. הכלים הקיימים
(`get_current_time`, `get_business_hours`, `get_order_status`, `check_balance`,
`find_branch`, `slow_lookup`) מחזירים נתוני דמו דטרמיניסטיים — אותו מספר הזמנה
תמיד יחזיר אותו סטטוס, כך ששיחת בדיקה היא שחזורית.

**כלי שליטה בשיחה** מתרגמים החלטה של המודל לפקודת JSON למרכזייה:
`transfer_to_agent`, `transfer_to_phone`, `end_call`, `save_answer`.

### מחשבון

`calculate` מקבל ביטוי ומחזיר מספר. הביטוי מפורסר ע"י מפרסר רקורסיבי שכתוב ביד
(`src/tools/expression.ts`) ולא ע"י `eval` — הקלט הוא מחרוזת שמודל הרכיב ממה
שזר אמר בטלפון, והדקדוק הזה לא יכול לייצר שום דבר חוץ ממספר. תומך
ב-`+ - * / ^ ( )`. חילוק באפס, גלישה וקלט לא חשבוני חוזרים כשגיאה מנוסחת, לא
כקריסה ולא כמספר שגוי.

`%` נדחה בכוונה: הוא יכול להתפרש כמודולו או כאחוזים, ובחירה שקטה באחד מהם
מייצרת מספרים שגויים בביטחון מלא. במקום זה חוזרת שגיאה עם רמז —
"18 אחוז מ-1250 הוא `1250*0.18`".

**לאמת שהוא בשימוש:**
```bash
journalctl -u ai-straem -o cat | grep 'calculator evaluated'
```
כל קריאה רושמת את הביטוי המקורי, הביטוי המנורמל, התוצאה והערך המדובר:
```json
{"expression":"1250*1.18","normalized":"1250*1.18","value":1475,"spoken":"1475",
 "msg":"calculator evaluated an expression"}
```

### איחולים — וההבטחה שהם באים רק מהקטלוג

`data/blessings.json` הוא המקור היחיד. `get_blessing` מחזיר רשומה אחת מילה
במילה, עם `blessing_id`, וההנחיה בפרומפט אוסרת על המודל לנסח איחול בעצמו.

**אבל פרומפט הוא לא אכיפה.** אי אפשר *למנוע* ממודל שפה לאלתר איחול — אפשר רק
להפוך כל מקרה כזה לגלוי. לכן יש `BlessingAudit`: הוא קורא את התמלול של המודל
עצמו (`outputAudioTranscription`), ולכל תור בודק אם יש בו שפת איחול שלא מתחקה
אחרי רשומה שהכלי באמת הגיש. ההתאמה היא לפי חפיפת מילים ולא לפי זהות תווים,
כי התמלול אינו זהה לטקסט המקור.

כך שהמשפט "איחולים מגיעים רק דרך הכלי" מפסיק להיות תקווה והופך למשהו שאפשר
לעשות עליו grep:

```bash
# מה הוגש מהקטלוג
journalctl -u ai-straem -o cat | grep 'blessing served from catalogue'

# סיכום אחד לכל שיחה — זו השורה שמעניינת
journalctl -u ai-straem -o cat | grep 'blessing audit'

# ⚠️ איחול שהמודל המציא
journalctl -u ai-straem -o cat | grep -i 'not from catalogue'
```

שיחה תקינה מסיימת ב:
```json
{"blessingsServed":1,"blessingIds":["wedding-1"],"improvisedBlessings":0,
 "courtesyPhrases":1,"clean":true,"msg":"blessing audit: clean — every blessing came from the catalogue"}
```

אם `clean:false` — יש שורת `blessing not from catalogue` עם המשפט המדויק שנאמר.
`BLESSING_AUDIT_STRICT=true` מעלה את זה לרמת `error` כדי שיהיה קל להתריע.

נימוסים קצרים ("מזל טוב", "בהצלחה") נספרים בנפרד כ-`courtesyPhrases` ואינם
נחשבים לאיחול מאולתר — הם לגיטימיים בסיום שיחה.

**להוסיף איחולים:** ערוך `data/blessings.json` והפעל מחדש. המזהים הם מיקומיים
(`wedding-1`, `wedding-2`), לכן הוספה לסוף הרשימה שומרת על מזהים קיימים.

### להוסיף כלי

```ts
const getTicket: ToolDefinition<{ ticket_id: string }> = {
  name: 'get_ticket',
  description: 'סטטוס קריאת שירות לפי מספר. אמור "רגע, בודק" לפני הקריאה.',
  parameters: {
    type: Type.OBJECT,
    properties: { ticket_id: { type: Type.STRING, description: 'מספר הקריאה' } },
    required: ['ticket_id'],
  },
  input: z.object({ ticket_id: z.string().regex(/^\d{4,10}$/) }),  // ולידציה בזמן ריצה
  timeoutMs: 3000,
  handler: async (args) => ({ status: await db.lookup(args.ticket_id) }),
};
```

`parameters` הוא מה שהמודל רואה; `input` הוא מה שנאכף בפועל. שני הדברים נחוצים —
ארגומנטים שמודל המציא הם קלט לא מהימן.

התוצאה חוזרת עטופה: `{ status: 'ok', result: {...} }`, או
`{ status: 'error', error: 'timeout' | 'invalid_arguments' | 'tool_failed' }`.
ה-registry לעולם לא זורק — קריאת כלי שנשארת בלי תשובה מקפיאה את השיחה.

### תקציב זמן

בצ'אט משתמש מחכה שתי שניות בשלווה; בטלפון שתי שניות של שקט נשמעות כמו שיחה שנפלה.
לכן: `TOOL_TIMEOUT_MS` (ברירת מחדל 4 שניות) על כל כלי, וההנחיה מבקשת מהמודל לומר
משפט קצר לפני קריאה איטית. `slow_lookup` קיים כדי לשמוע את זה בפועל — בקש ממנו
להמתין עשר שניות ותשמע את מסלול ה-timeout עובד.

## ההחלטות שקובעות אם השיחה נשמעת טוב

**קצב זמן אמת.** המודל מייצר אודיו מהר בהרבה מהזמן שלוקח להשמיע אותו. `PbxWriter`
משדר פריים אחד של 20ms כל 20ms, על שעון שמתקן סחיפה, עם תקרה על התאוששות אחרי
תקיעת event loop. בלי זה המתקשר שומע עיכוב שהולך וגדל.

**כותב יחיד.** אודיו ופקודות מגיעים ממסלולים אסינכרוניים שונים ועוברים דרך תור אחד.
פקודות עוקפות אודיו שממתין (`clear` שימושי רק אם הוא מקדים את מה שמאחוריו).

**סינון anti-alias.** דצימציה מ-24k ל-8k בלי low-pass מקדים מקפלת תדרים גבוהים
בחזרה לתוך פס הדיבור והקול נשמע מתכתי. הטסט מוודא דעיכה של יותר מ-40dB מחוץ לפס.

**barge-in ממותן.** ה-VAD של המודל נדלק גם על רעש רקע. פקודת `clear` נשלחת רק
כששער העוצמה שלנו מסכים שהמתקשר באמת מדבר — אחרת הבוט נקטע כשמשאית עוברת.

**שקט עולה כסף.** אודיו מתחת לסף לא נשלח למודל. ה-hangover (1.5 שניות) ממשיך
לשדר אחרי שהעוצמה יורדת, כדי שה-VAD של המודל יראה את סוף הדיבור ויסגור את התור.

**פקודה סופית אחת.** אחרי `transfer_*` או `hangup` המרכזייה מנקזת עד שש שניות של
אודיו ורק אז מבצעת — לכן הן נשלחות כשהמודל *מתחיל* את משפט הסיום, והאודיו ממשיך
לזרום אחריהן. פקודה סופית שנייה נדחית.

## פריסה ל-VPS

TLS מסתיים ב-nginx; Node מאזין ב-HTTP מקומי. ראה `deploy/nginx.conf.example`
(שים לב ל-`proxy_read_timeout` — ברירת המחדל של 60 שניות מנתקת שיחה באמצע) ו-
`deploy/ai-straem.service`.

```bash
npm run build && npm start
```

בממשק המרכזייה: **מודולים ← סטרימינג ← ＋ ערוץ סטרימינג**, נקודת קצה
`wss://your.domain/voice`, וסוד האימות זהה ל-`AUTH_SECRET`.

## מה עוד לא מאומת מול המערכת האמיתית

התיעוד של הספק מציין את סוגי ההודעות ומראה פקודה אחת מילולית
(`{"type":"transfer_extension","target":"/2"}`), אבל לא מפרט את שמות השדות בתוך
`start`, `dtmf` ו-`save_answer`.

לכן `parseInbound` מקבל כמה איותים סבירים לכל שדה ותמיד שומר את ה-JSON הגולמי.
הרץ שיחת בדיקה אחת עם `LOG_LEVEL=debug` — כל הודעה נכנסת נרשמת עם `raw`, וזה
חושף את הסכימה האמיתית. אם שם שדה שונה, השינוי הוא בקובץ אחד.

באותו אופן, מבנה `save_answer` הוא `{type, name, value}` לפי התיאור המילולי —
כדאי לאמת מול דוח במרכזייה אחרי הבדיקה הראשונה.

## משתני סביבה

ראה `.env.example`. אלה שמשנים את התנהגות השיחה:

| משתנה | ברירת מחדל | מתי לגעת |
|---|---|---|
| `MODE` | `bot` | `echo` לבדיקת החיבור בלי מודל |
| `SPEECH_THRESHOLD_DBFS` | `-45` | העלה (למשל `-40`) בקו רועש; הורד אם מתקשרים שקטים נחתכים |
| `SPEECH_HANGOVER_MS` | `1500` | הגדל אם המודל לא מזהה שהמתקשר סיים |
| `SUPPRESS_SILENCE` | `true` | `false` אם יש חשד שחוסר האודיו מבלבל את ה-VAD |
| `GATE_BARGE_IN` | `true` | `false` כדי לכבד כל `interrupted` של המודל |
| `TOOL_TIMEOUT_MS` | `4000` | לפי הכלי האיטי ביותר שאתה מוכן לסבול על הקו |
| `RECORD_DIR` | — | הפעל לדיבוג: `caller.wav` + `bot.wav` לכל שיחה |
