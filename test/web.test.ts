import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import WebSocket from 'ws';

/** The management API and per-user PBX channels, over real HTTP, in echo mode. */
const PORT = 9000 + Math.floor(Math.random() * 900);
const DIR = mkdtempSync(join(tmpdir(), 'ai-straem-web-'));
const ADMIN = { email: 'admin@example.test', password: 'admin-password-1' };

process.env['AUTH_SECRET'] = 'legacy-secret';
process.env['MODE'] = 'echo';
process.env['PORT'] = String(PORT);
process.env['LOG_LEVEL'] = 'silent';
process.env['LOG_PRETTY'] = 'false';
process.env['DB_PATH'] = join(DIR, 'test.sqlite');
process.env['ADMIN_EMAIL'] = ADMIN.email;
process.env['ADMIN_PASSWORD'] = ADMIN.password;
process.env['SECURE_COOKIES'] = 'false';

const base = `http://127.0.0.1:${PORT}`;
let server: Server;

before(async () => {
  const { bootstrapAdmin } = await import('../src/web/app.js');
  const { startServer } = await import('../src/server.js');
  await bootstrapAdmin();
  server = startServer();
  await new Promise((r) => server.once('listening', r));
});

after(async () => {
  server.close();
  const { getStore } = await import('../src/db.js');
  getStore().db.close(); // Windows will not delete an open database file
  rmSync(DIR, { recursive: true, force: true });
});

async function call(method: string, path: string, opts: { cookie?: string; body?: unknown; raw?: Buffer; csrf?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers['cookie'] = opts.cookie;
  if (opts.csrf !== false && method !== 'GET') headers['x-requested-with'] = 'fetch';
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
}

async function login(email: string, password: string): Promise<string> {
  const r = await call('POST', '/api/login', { body: { email, password } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.cookie;
}

function connect(path: string, secret: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, { headers: { Authorization: `Bearer ${secret}` } });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

test('the UI is served and the API needs a session', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/);
  assert.equal((await call('GET', '/api/me')).status, 401);
});

test('wrong password is rejected; the bootstrap admin can sign in', async () => {
  assert.equal((await call('POST', '/api/login', { body: { email: ADMIN.email, password: 'nope-nope' } })).status, 401);
  const cookie = await login(ADMIN.email, ADMIN.password);
  const me = await call('GET', '/api/me', { cookie });
  assert.equal(me.json.user.role, 'admin');
});

test('state-changing calls without the CSRF header are refused', async () => {
  const cookie = await login(ADMIN.email, ADMIN.password);
  const r = await call('PUT', '/api/admin/prompt', { cookie, body: { prompt: 'x'.repeat(30) }, csrf: false });
  assert.equal(r.status, 403);
});

test('admin adds a user; the user has their own channel and no admin access', async () => {
  const admin = await login(ADMIN.email, ADMIN.password);
  const created = await call('POST', '/api/admin/users', {
    cookie: admin,
    body: { email: 'user@example.test', name: 'משתמש', password: 'user-password-1', role: 'user' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));

  const user = await login('user@example.test', 'user-password-1');
  assert.equal((await call('GET', '/api/admin/users', { cookie: user })).status, 403);

  const mine = (await call('GET', '/api/settings', { cookie: user })).json;
  const theirs = (await call('GET', '/api/settings', { cookie: admin })).json;
  assert.notEqual(mine.channel.path, theirs.channel.path);

  const ws = await connect(mine.channel.path, mine.channel.secret);
  ws.close();
  await assert.rejects(() => connect(mine.channel.path, theirs.channel.secret), /HTTP 401/);
  await assert.rejects(() => connect('/voice/no-such-key', mine.channel.secret), /HTTP 404/);

  // A rotated secret takes effect at once.
  const rotated = (await call('POST', '/api/settings/rotate-secret', { cookie: user })).json;
  await assert.rejects(() => connect(mine.channel.path, mine.channel.secret), /HTTP 401/);
  (await connect(rotated.channel.path, rotated.channel.secret)).close();
});

test('a deactivated user is signed out and cannot sign in', async () => {
  const admin = await login(ADMIN.email, ADMIN.password);
  const created = await call('POST', '/api/admin/users', {
    cookie: admin,
    body: { email: 'gone@example.test', name: 'זמני', password: 'gone-password-1', role: 'user' },
  });
  const session = await login('gone@example.test', 'gone-password-1');
  await call('PATCH', `/api/admin/users/${created.json.user.id}`, { cookie: admin, body: { active: false } });
  assert.equal((await call('GET', '/api/me', { cookie: session })).status, 401);
  assert.equal((await call('POST', '/api/login', { body: { email: 'gone@example.test', password: 'gone-password-1' } })).status, 401);
});

test('contacts: add, reject a duplicate, import a CSV, keep users apart', async () => {
  const user = await login('user@example.test', 'user-password-1');
  const added = await call('POST', '/api/contacts', { cookie: user, body: { name: 'שלמה', phone: '052-111-2222' } });
  assert.equal(added.json.contact.phone, '0521112222');
  assert.equal((await call('POST', '/api/contacts', { cookie: user, body: { name: 'כפול', phone: '0521112222' } })).status, 409);

  const csv = Buffer.from('שם,טלפון\nרחל,0533334444\nשלמה לוי,0521112222\nבלי מספר,\n');
  const imported = await call('POST', '/api/contacts/import', { cookie: user, raw: csv });
  assert.deepEqual(imported.json, { added: 1, updated: 1, skipped: 1 });

  const list = (await call('GET', '/api/contacts', { cookie: user })).json.contacts;
  assert.deepEqual(list.map((c: { name: string }) => c.name).sort(), ['רחל', 'שלמה לוי']);

  const admin = await login(ADMIN.email, ADMIN.password);
  assert.equal((await call('GET', '/api/contacts', { cookie: admin })).json.contacts.length, 0);
  assert.equal((await call('DELETE', `/api/contacts/${list[0].id}`, { cookie: admin })).status, 404);
});

test('requests are private to their owner and can be marked done', async () => {
  const { getStore } = await import('../src/db.js');
  const owner = getStore().getUserByEmail('user@example.test')!;
  const rid = getStore().insertRequest({
    userId: owner.id,
    callId: 'c1',
    caller: '0521112222',
    contactName: 'שלמה לוי',
    startedAt: new Date().toISOString(),
    durationMs: 30_000,
    answers: { message: 'תחזור אליי' },
    transcript: [{ role: 'caller', text: 'שלום' }],
    recording: null,
  });

  const user = await login('user@example.test', 'user-password-1');
  const list = (await call('GET', '/api/requests', { cookie: user })).json.requests;
  assert.equal(list[0].answers.message, 'תחזור אליי');
  assert.equal((await call('PATCH', `/api/requests/${rid}`, { cookie: user, body: { status: 'done' } })).status, 204);
  assert.equal((await call('GET', '/api/requests?status=new', { cookie: user })).json.requests.length, 0);

  const admin = await login(ADMIN.email, ADMIN.password);
  assert.equal((await call('GET', `/api/requests/${rid}`, { cookie: admin })).status, 404);
});

test('the admin edits the global prompt', async () => {
  const admin = await login(ADMIN.email, ADMIN.password);
  const before = (await call('GET', '/api/admin/prompt', { cookie: admin })).json;
  assert.equal(before.isDefault, true);
  await call('PUT', '/api/admin/prompt', { cookie: admin, body: { prompt: 'אתה רק רושם הודעות. אל תיתן מידע.' } });
  const after = (await call('GET', '/api/admin/prompt', { cookie: admin })).json;
  assert.equal(after.isDefault, false);
  assert.equal(after.prompt, 'אתה רק רושם הודעות. אל תיתן מידע.');
});
