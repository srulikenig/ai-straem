import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlessingAudit } from '../src/agent/blessingAudit.js';
import { BlessingCatalog } from '../src/tools/blessings.js';
import { logger } from '../src/logger.js';

const log = logger.child({ test: true });
const audit = (): BlessingAudit => new BlessingAudit({ log, strict: false });
const catalog = BlessingCatalog.load();
const wedding = catalog.find('wedding')!.blessings[0]!;

test('a blessing read back from the catalogue is accepted', () => {
  const a = audit();
  a.recordServed(wedding);
  const findings = a.checkTurn(wedding.text);
  assert.deepEqual(findings, []);
  assert.equal(a.summary.clean, true);
  assert.equal(a.summary.blessingsServed, 1);
});

test('tolerates the wording drift of output transcription', () => {
  const a = audit();
  a.recordServed(wedding);
  // Transcription is not character-identical: punctuation and a filler word differ.
  const spoken = 'אז מזל טוב וברכה שתזכו לבנות בית נאמן בישראל בית של שלום ושל שמחה ושהאהבה שביניכם תלך ותגדל עם השנים';
  assert.deepEqual(a.checkTurn(spoken), []);
});

test('catches a blessing the model composed itself', () => {
  const a = audit(); // nothing served
  const findings = a.checkTurn('אני מאחל לך שתזכה לבריאות ולהצלחה בכל אשר תפנה, ושתמיד תראה רק טוב.');
  assert.equal(findings.length, 1);
  assert.ok(['מאחל', 'שתזכה'].includes(findings[0]!.marker));
  assert.equal(a.summary.clean, false);
  assert.equal(a.summary.improvisedBlessings, 1);
});

test('catches an improvised blessing even when a different one was served', () => {
  const a = audit();
  a.recordServed(wedding);
  // Read the wedding blessing correctly, then invent a recovery one.
  const findings = a.checkTurn(`${wedding.text} ואני גם מאחל לאמא שלך רפואה שלמה ומהירה בקרוב מאוד.`);
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.sentence, /רפואה שלמה/);
});

test('a short courtesy is not treated as an improvised blessing', () => {
  const a = audit();
  assert.deepEqual(a.checkTurn('מזל טוב! אני מעביר אותך עכשיו לנציג.'), []);
  assert.deepEqual(a.checkTurn('בהצלחה, יום טוב.'), []);
  assert.equal(a.summary.clean, true);
  assert.ok(a.summary.courtesyPhrases > 0, 'still counted, just not flagged');
});

test('ordinary conversation produces no findings', () => {
  const a = audit();
  assert.deepEqual(
    a.checkTurn('ההזמנה שלך יצאה למשלוח והיא אמורה להגיע מחר. משהו נוסף?'),
    [],
  );
  assert.deepEqual(a.checkTurn('הסכום הוא אלף ארבע מאות שבעים וחמש שקלים.'), []);
  assert.equal(a.summary.clean, true);
});

test('findings accumulate across turns and the summary reflects it', () => {
  const a = audit();
  a.checkTurn('אני מאחל לך שתזכה לכל הברכות שבעולם ולאריכות ימים.');
  a.checkTurn('ועוד משהו, יהי רצון שתמצא את מה שאתה מחפש בקרוב מאוד ובשורות טובות.');
  assert.equal(a.summary.improvisedBlessings, 2);
  assert.equal(a.summary.clean, false);
});

test('every catalogue blessing validates against itself', () => {
  // Guards the catalogue against text the audit itself would flag.
  for (const blessing of catalog.all) {
    const a = audit();
    a.recordServed(blessing);
    assert.deepEqual(
      a.checkTurn(blessing.text),
      [],
      `catalogue entry ${blessing.id} should not be flagged when read verbatim`,
    );
  }
});
