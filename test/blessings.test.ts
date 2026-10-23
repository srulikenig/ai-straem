import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlessingCatalog, blessingTools, type Blessing } from '../src/tools/blessings.js';
import { calculatorTool } from '../src/tools/calculator.js';
import { ToolRegistry, type ToolContext } from '../src/tools/registry.js';
import { logger } from '../src/logger.js';
import { expectOk } from './helpers.js';

const ctx: ToolContext = {
  callId: 'test',
  caller: '0501234567',
  call: {
    saveAnswer: () => {},
    transferExtension: () => {},
    transferPhone: () => {},
    endCall: () => {},
    get closing() {
      return false;
    },
  },
  log: logger.child({ test: true }),
};

test('the shipped catalogue loads and is well formed', () => {
  const catalog = BlessingCatalog.load();
  assert.ok(catalog.occasions.length >= 5);
  for (const occ of catalog.occasions) {
    assert.ok(occ.id.length > 0, 'every occasion has an id');
    assert.ok(occ.blessings.length > 0, `${occ.id} has at least one blessing`);
    for (const b of occ.blessings) {
      assert.ok(b.text.length > 10, `${b.id} has real text`);
      assert.match(b.id, /^[a-z_]+-\d+$/);
    }
  }
  // Ids must be unique, or the audit cannot tell blessings apart.
  const ids = catalog.all.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a malformed catalogue fails at load, not mid-call', () => {
  assert.throws(() => new BlessingCatalog({ occasions: [] }));
  assert.throws(() => new BlessingCatalog({ occasions: [{ id: 'x', label: 'X', blessings: [] }] }));
});

test('occasion lookup accepts the id, the Hebrew label and aliases', () => {
  const c = BlessingCatalog.load();
  assert.equal(c.find('wedding')?.id, 'wedding');
  assert.equal(c.find('חתונה')?.id, 'wedding');
  assert.equal(c.find('נישואין')?.id, 'wedding');
  assert.equal(c.find('רפואה שלמה')?.id, 'recovery');
  assert.equal(c.find('החתונה של אחי')?.id, 'wedding', 'resolves inside a longer phrase');
  assert.equal(c.find('משהו אחר לגמרי'), null);
});

function registry(onServed?: (b: Blessing) => void): ToolRegistry {
  const r = new ToolRegistry(4000).register(calculatorTool);
  const opts = { catalog: BlessingCatalog.load(), ...(onServed ? { onServed } : {}) };
  return r.registerAll(blessingTools(opts));
}

test('get_blessing returns catalogue text verbatim and reports what it served', async () => {
  const served: Blessing[] = [];
  const r = await registry((b) => served.push(b)).execute('get_blessing', { occasion: 'חתונה' }, ctx);
  const out = expectOk(r);

  assert.equal(out['found'], true);
  assert.equal(served.length, 1, 'the audit hook fired exactly once');
  assert.equal(out['text'], served[0]!.text, 'the text handed over is the catalogue text');
  assert.equal(out['blessing_id'], served[0]!.id);

  const catalog = BlessingCatalog.load();
  assert.ok(
    catalog.all.some((b) => b.text === out['text']),
    'the text exists in the catalogue unmodified',
  );
});

test('variant selects a different wording and wraps round', async () => {
  const reg = registry();
  const a = expectOk(await reg.execute('get_blessing', { occasion: 'wedding', variant: 1 }, ctx));
  const b = expectOk(await reg.execute('get_blessing', { occasion: 'wedding', variant: 2 }, ctx));
  assert.notEqual(a['text'], b['text']);

  const count = Number(a['variants_available']);
  const wrapped = expectOk(await reg.execute('get_blessing', { occasion: 'wedding', variant: count + 1 }, ctx));
  assert.equal(wrapped['text'], a['text'], 'wraps instead of failing');
});

test('an unknown occasion serves nothing and tells the model not to improvise', async () => {
  const served: Blessing[] = [];
  const out = expectOk(
    await registry((b) => served.push(b)).execute('get_blessing', { occasion: 'יום השוקולד' }, ctx),
  );
  assert.equal(out['found'], false);
  assert.equal(served.length, 0, 'nothing was served, so nothing is attributable to the catalogue');
  assert.ok(Array.isArray(out['available']));
  assert.match(String(out['instruction']), /אל תנסח/);
});

test('list_blessing_occasions reports every occasion with its count', async () => {
  const out = expectOk(await registry().execute('list_blessing_occasions', {}, ctx));
  const occasions = out['occasions'] as Array<{ id: string; count: number }>;
  assert.equal(occasions.length, BlessingCatalog.load().occasions.length);
  assert.ok(occasions.every((o) => o.count > 0));
});

test('the calculator tool is reachable through the registry and logs its result', async () => {
  const out = expectOk(await registry().execute('calculate', { expression: '1250*1.18' }, ctx));
  assert.equal(out['result'], 1475);
  assert.equal(out['spoken'], '1475');
  assert.equal(out['normalized'], '1250*1.18');
});

test('a bad expression comes back as a usable instruction, not a crash', async () => {
  const out = expectOk(await registry().execute('calculate', { expression: '5/0' }, ctx));
  assert.equal(out['ok'], false);
  assert.match(String(out['error']), /אפס/);
});
