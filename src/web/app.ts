import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getStore, type CallRequest, type User } from '../db.js';
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../auth.js';
import { normalizePhone, readContactsFile } from '../contacts.js';
import {
  DEFAULT_GLOBAL_PROMPT,
  DEFAULT_USER_INSTRUCTIONS,
  DEFAULT_VOICE,
  GLOBAL_PROMPT_KEY,
  globalPrompt,
  VOICES,
} from '../agent/prompt.js';
import { ANSWER_LABELS } from '../agent/requestReport.js';

/**
 * The management app: a small JSON API and the static single-page UI.
 *
 * CSRF: the session cookie is SameSite=Strict, and every state-changing call
 * must carry the X-Requested-With header — a cross-site form cannot set it.
 */

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const COOKIE = 'sid';
const JSON_LIMIT = 256 * 1024;
const UPLOAD_LIMIT = 5 * 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  user: User;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

type Auth = 'public' | 'user' | 'admin';
type Handler = (ctx: Ctx) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  auth: Auth;
  /** Hand the raw request body (a file upload) instead of parsed JSON. */
  raw: boolean;
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, path: string, auth: Auth, handler: Handler, raw = false): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:(\w+)/g, (_m, k: string) => {
      keys.push(k);
      return '([^/]+)';
    })}$`,
  );
  routes.push({ method, pattern, keys, auth, raw, handler });
}

/* --------------------------------- helpers -------------------------------- */

function clientIp(req: IncomingMessage): string {
  const h = req.headers['cf-connecting-ip'] ?? req.headers['x-real-ip'];
  return (Array.isArray(h) ? h[0] : h) ?? req.socket.remoteAddress ?? '?';
}

function readCookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSessionCookie(res: ServerResponse, token: string | null): void {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict', ...(config.app.secureCookies ? ['Secure'] : [])];
  const value = token ? `${COOKIE}=${token}; Max-Age=${30 * 86_400}` : `${COOKIE}=; Max-Age=0`;
  res.setHeader('set-cookie', [value, ...attrs].join('; '));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'הקובץ גדול מדי');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, r.error.issues[0]?.message ?? 'קלט לא תקין');
  return r.data;
}

const id = (ctx: Ctx) => {
  const n = Number(ctx.params['id']);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'לא נמצא');
  return n;
};

function publicUser(u: User) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, createdAt: u.createdAt };
}

function requestSummary(r: CallRequest) {
  const { transcript, recording, ...rest } = r;
  return { ...rest, hasRecording: Boolean(recording), firstWords: transcript.find((t) => t.role === 'caller')?.text.trim() ?? '' };
}

/* ----------------------------- login throttling ---------------------------- */

const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILURES = 10;
const failures = new Map<string, { count: number; resetAt: number }>();

function checkThrottle(ip: string): void {
  const f = failures.get(ip);
  if (f && f.resetAt > Date.now() && f.count >= LOGIN_MAX_FAILURES) {
    throw new HttpError(429, 'יותר מדי ניסיונות כושלים. נסה שוב בעוד רבע שעה.');
  }
}

function recordFailure(ip: string): void {
  const f = failures.get(ip);
  if (!f || f.resetAt <= Date.now()) failures.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  else f.count++;
}

/* --------------------------------- schemas -------------------------------- */

const password = z.string().min(MIN_PASSWORD_LENGTH, `סיסמה של ${MIN_PASSWORD_LENGTH} תווים לפחות`).max(200);
const email = z.string().trim().email('כתובת מייל לא תקינה').max(200);
const optionalEmail = z.union([z.literal(''), email]);
const voiceId = z.string().refine((v) => VOICES.some((x) => x.id === v), 'קול לא מוכר');

const contactSchema = z.object({
  name: z.string().trim().min(1, 'חסר שם').max(120),
  phone: z.string().transform((p, c) => {
    const n = normalizePhone(p);
    if (!n) c.addIssue({ code: 'custom', message: 'מספר טלפון לא תקין' });
    return n ?? '';
  }),
  notes: z.string().trim().max(500).default(''),
});

/* --------------------------------- session -------------------------------- */

route('POST', '/api/login', 'public', async ({ req, res, body }) => {
  const ip = clientIp(req);
  checkThrottle(ip);
  const b = parse(z.object({ email: z.string(), password: z.string() }), body);
  const user = getStore().getUserByEmail(b.email);
  if (!user || !user.active || !(await verifyPassword(b.password, user.passwordHash))) {
    recordFailure(ip);
    logger.warn({ ip, email: b.email }, 'web login failed');
    throw new HttpError(401, 'מייל או סיסמה שגויים');
  }
  failures.delete(ip);
  setSessionCookie(res, getStore().createSession(user.id));
  logger.info({ ip, user: user.id }, 'web login');
  return { user: publicUser(user) };
});

route('POST', '/api/logout', 'user', ({ req, res }) => {
  const token = readCookie(req, COOKIE);
  if (token) getStore().deleteSession(token);
  setSessionCookie(res, null);
});

route('GET', '/api/me', 'user', ({ user }) => ({ user: publicUser(user) }));

route('POST', '/api/me/password', 'user', async ({ user, body }) => {
  const b = parse(z.object({ current: z.string(), next: password }), body);
  if (!(await verifyPassword(b.current, user.passwordHash))) throw new HttpError(400, 'הסיסמה הנוכחית שגויה');
  getStore().updateUser(user.id, { passwordHash: await hashPassword(b.next) });
});

/* -------------------------------- requests -------------------------------- */

route('GET', '/api/requests', 'user', ({ user, query }) => {
  const status = query.get('status');
  const list = getStore().listRequests(user.id, status === 'new' || status === 'done' ? status : undefined);
  return { requests: list.map(requestSummary), labels: ANSWER_LABELS };
});

route('GET', '/api/requests/:id', 'user', (ctx) => {
  const r = getStore().getRequest(ctx.user.id, id(ctx));
  if (!r) throw new HttpError(404, 'הפנייה לא נמצאה');
  const { recording, ...rest } = r;
  return { request: { ...rest, hasRecording: Boolean(recording) }, labels: ANSWER_LABELS };
});

route('PATCH', '/api/requests/:id', 'user', (ctx) => {
  const b = parse(z.object({ status: z.enum(['new', 'done']) }), ctx.body);
  if (!getStore().setRequestStatus(ctx.user.id, id(ctx), b.status)) throw new HttpError(404, 'הפנייה לא נמצאה');
});

route('GET', '/api/requests/:id/recording', 'user', async (ctx) => {
  const r = getStore().getRequest(ctx.user.id, id(ctx));
  if (!r?.recording) throw new HttpError(404, 'אין הקלטה');
  await sendFile(ctx.req, ctx.res, r.recording, 'audio/wav');
  return SENT;
});

/* -------------------------------- contacts -------------------------------- */

route('GET', '/api/contacts', 'user', ({ user }) => ({ contacts: getStore().listContacts(user.id) }));

route('POST', '/api/contacts', 'user', ({ user, body }) => {
  const c = parse(contactSchema, body);
  if (getStore().findContactByPhone(user.id, c.phone)) throw new HttpError(409, 'איש קשר עם המספר הזה כבר קיים');
  getStore().upsertContacts(user.id, [c]);
  return { contact: getStore().findContactByPhone(user.id, c.phone) };
});

route('PUT', '/api/contacts/:id', 'user', (ctx) => {
  const c = parse(contactSchema, ctx.body);
  const other = getStore().findContactByPhone(ctx.user.id, c.phone);
  if (other && other.id !== id(ctx)) throw new HttpError(409, 'איש קשר אחר כבר משתמש במספר הזה');
  const updated = getStore().updateContact(ctx.user.id, id(ctx), c);
  if (!updated) throw new HttpError(404, 'איש הקשר לא נמצא');
  return { contact: updated };
});

route('DELETE', '/api/contacts/:id', 'user', (ctx) => {
  if (!getStore().deleteContact(ctx.user.id, id(ctx))) throw new HttpError(404, 'איש הקשר לא נמצא');
});

route(
  'POST',
  '/api/contacts/import',
  'user',
  async ({ user, body }) => {
    let parsed;
    try {
      parsed = await readContactsFile(body as Buffer);
    } catch {
      throw new HttpError(400, 'לא הצלחתי לקרוא את הקובץ. שמור אותו כ-Excel (xlsx) או CSV ונסה שוב.');
    }
    const { added, updated } = getStore().upsertContacts(user.id, parsed.contacts);
    return { added, updated, skipped: parsed.skipped };
  },
  true,
);

/* -------------------------------- settings -------------------------------- */

function settingsOf(u: User) {
  return {
    instructions: u.instructions,
    greeting: u.greeting,
    greetByName: u.greetByName,
    notifyEmail: u.notifyEmail,
    voice: u.voice || DEFAULT_VOICE,
    channel: { path: `${config.server.path}/${u.channelKey}`, secret: u.channelSecret },
    voices: VOICES,
    defaultInstructions: DEFAULT_USER_INSTRUCTIONS,
  };
}

route('GET', '/api/settings', 'user', ({ user }) => settingsOf(user));

route('PUT', '/api/settings', 'user', ({ user, body }) => {
  const b = parse(
    z.object({
      instructions: z.string().max(8000),
      greeting: z.string().trim().max(400),
      greetByName: z.boolean(),
      notifyEmail: optionalEmail,
      voice: voiceId,
    }),
    body,
  );
  return settingsOf(getStore().updateUser(user.id, b)!);
});

route('POST', '/api/settings/rotate-secret', 'user', ({ user }) => settingsOf(getStore().rotateChannelSecret(user.id)!));

/* ---------------------------------- admin --------------------------------- */

route('GET', '/api/admin/users', 'admin', () => ({ users: getStore().listUsers().map(publicUser) }));

route('POST', '/api/admin/users', 'admin', async ({ body }) => {
  const b = parse(
    z.object({ email, name: z.string().trim().min(1, 'חסר שם').max(120), password, role: z.enum(['admin', 'user']) }),
    body,
  );
  if (getStore().getUserByEmail(b.email)) throw new HttpError(409, 'משתמש עם המייל הזה כבר קיים');
  const user = getStore().createUser({
    email: b.email,
    name: b.name,
    role: b.role,
    passwordHash: await hashPassword(b.password),
    instructions: DEFAULT_USER_INSTRUCTIONS,
    voice: DEFAULT_VOICE,
  });
  getStore().updateUser(user.id, { notifyEmail: b.email });
  return { user: publicUser(user) };
});

route('PATCH', '/api/admin/users/:id', 'admin', async (ctx) => {
  const b = parse(
    z.object({
      name: z.string().trim().min(1).max(120).optional(),
      role: z.enum(['admin', 'user']).optional(),
      active: z.boolean().optional(),
      password: password.optional(),
    }),
    ctx.body,
  );
  const target = id(ctx);
  if (target === ctx.user.id && (b.active === false || b.role === 'user')) {
    throw new HttpError(400, 'אי אפשר להשבית או להוריד הרשאות לעצמך');
  }
  const updated = getStore().updateUser(target, {
    name: b.name,
    role: b.role,
    active: b.active,
    passwordHash: b.password ? await hashPassword(b.password) : undefined,
  });
  if (!updated) throw new HttpError(404, 'המשתמש לא נמצא');
  return { user: publicUser(updated) };
});

route('GET', '/api/admin/prompt', 'admin', () => ({
  prompt: globalPrompt(getStore()),
  isDefault: getStore().getSetting(GLOBAL_PROMPT_KEY) === null,
  defaultPrompt: DEFAULT_GLOBAL_PROMPT,
}));

route('PUT', '/api/admin/prompt', 'admin', ({ body }) => {
  const b = parse(z.object({ prompt: z.string().trim().min(20, 'ההנחיה קצרה מדי').max(12000) }), body);
  getStore().setSetting(GLOBAL_PROMPT_KEY, b.prompt);
});

/* ------------------------------ static & files ----------------------------- */

const SENT = Symbol('sent');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Streams a file, honouring a single Range so the audio player can seek. */
async function sendFile(req: IncomingMessage, res: ServerResponse, path: string, type: string): Promise<void> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new HttpError(404, 'הקובץ לא נמצא');
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' });
    createReadStream(path, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
  createReadStream(path).pipe(res);
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  // The UI routes on the hash, so only "/" is the page; anything else must be a real file.
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = resolve(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + sep)) throw new HttpError(404, 'לא נמצא');
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    throw new HttpError(404, 'לא נמצא');
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(data);
}

/* --------------------------------- dispatch -------------------------------- */

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; media-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

export async function handleWeb(req: IncomingMessage, res: ServerResponse): Promise<void> {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'שיטה לא נתמכת');
      await serveStatic(url.pathname, res);
      return;
    }

    let matched: { route: Route; params: Record<string, string> } | null = null;
    let pathMatched = false;
    for (const r of routes) {
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      matched = { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)])) };
      break;
    }
    if (!matched) throw new HttpError(pathMatched ? 405 : 404, 'לא נמצא');
    const { route: r, params } = matched;

    if (method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, 'בקשה חסומה');

    let user: User | null = null;
    if (r.auth !== 'public') {
      const token = readCookie(req, COOKIE);
      user = token ? getStore().getSessionUser(token) : null;
      if (!user) throw new HttpError(401, 'נדרשת התחברות');
      if (r.auth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'אין הרשאה');
    }

    let body: unknown = undefined;
    if (method !== 'GET' && method !== 'DELETE') {
      const raw = await readBody(req, r.raw ? UPLOAD_LIMIT : JSON_LIMIT);
      if (r.raw) body = raw;
      else if (raw.length) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new HttpError(400, 'JSON לא תקין');
        }
      }
    }

    const result = await r.handler({ req, res, user: user!, params, query: url.searchParams, body });
    if (result === SENT) return;
    if (result === undefined) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(result));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) logger.error({ err, path: url.pathname }, 'web request failed');
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err instanceof HttpError ? err.message : 'שגיאה בשרת' }));
  }
}

/** On an empty database, create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD. */
export async function bootstrapAdmin(): Promise<void> {
  const store = getStore();
  if (store.countUsers() > 0) return;
  const { adminEmail, adminPassword } = config.app;
  if (!adminEmail || !adminPassword) {
    logger.warn('no users yet: set ADMIN_EMAIL and ADMIN_PASSWORD to create the first admin');
    return;
  }
  const user = store.createUser({
    email: adminEmail,
    name: 'מנהל',
    role: 'admin',
    passwordHash: await hashPassword(adminPassword),
    instructions: DEFAULT_USER_INSTRUCTIONS,
    voice: DEFAULT_VOICE,
  });
  store.updateUser(user.id, { notifyEmail: adminEmail });
  logger.info({ email: adminEmail }, 'created the first admin');
}
