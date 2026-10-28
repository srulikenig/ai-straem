import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { config } from './config.js';

export type Role = 'admin' | 'user';
export type RequestStatus = 'new' | 'done';

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  passwordHash: string;
  /** Path segment of this user's PBX channel: /voice/<channelKey>. */
  channelKey: string;
  /** Bearer secret the PBX sends on this user's channel. */
  channelSecret: string;
  /** The user's own instructions, always subordinate to the global ones. */
  instructions: string;
  /** Spoken first; empty lets the instructions decide the opening. */
  greeting: string;
  /** Address a known contact by name in the opening. */
  greetByName: boolean;
  notifyEmail: string;
  voice: string;
  createdAt: string;
}

export interface Contact {
  id: number;
  userId: number;
  name: string;
  phone: string;
  notes: string;
}

export interface TranscriptTurn {
  role: 'caller' | 'bot';
  text: string;
}

export interface CallRequest {
  id: number;
  userId: number;
  callId: string | null;
  caller: string | null;
  contactName: string | null;
  startedAt: string;
  durationMs: number;
  answers: Record<string, string>;
  transcript: TranscriptTurn[];
  recording: string | null;
  status: RequestStatus;
  emailed: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  active INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT NOT NULL,
  channel_key TEXT NOT NULL UNIQUE,
  channel_secret TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  greeting TEXT NOT NULL DEFAULT '',
  greet_by_name INTEGER NOT NULL DEFAULT 1,
  notify_email TEXT NOT NULL DEFAULT '',
  voice TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  UNIQUE (user_id, phone)
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  call_id TEXT,
  caller TEXT,
  contact_name TEXT,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  answers TEXT NOT NULL,
  transcript TEXT NOT NULL,
  recording TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'done')),
  emailed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS requests_by_user ON requests (user_id, started_at DESC);
`;

const SESSION_DAYS = 30;

type Row = Record<string, unknown>;

function toUser(r: Row): User {
  return {
    id: r['id'] as number,
    email: r['email'] as string,
    name: r['name'] as string,
    role: r['role'] as Role,
    active: r['active'] === 1,
    passwordHash: r['password_hash'] as string,
    channelKey: r['channel_key'] as string,
    channelSecret: r['channel_secret'] as string,
    instructions: r['instructions'] as string,
    greeting: r['greeting'] as string,
    greetByName: r['greet_by_name'] === 1,
    notifyEmail: r['notify_email'] as string,
    voice: r['voice'] as string,
    createdAt: r['created_at'] as string,
  };
}

function toContact(r: Row): Contact {
  return {
    id: r['id'] as number,
    userId: r['user_id'] as number,
    name: r['name'] as string,
    phone: r['phone'] as string,
    notes: r['notes'] as string,
  };
}

function toRequest(r: Row): CallRequest {
  return {
    id: r['id'] as number,
    userId: r['user_id'] as number,
    callId: r['call_id'] as string | null,
    caller: r['caller'] as string | null,
    contactName: r['contact_name'] as string | null,
    startedAt: r['started_at'] as string,
    durationMs: r['duration_ms'] as number,
    answers: JSON.parse(r['answers'] as string) as Record<string, string>,
    transcript: JSON.parse(r['transcript'] as string) as TranscriptTurn[],
    recording: r['recording'] as string | null,
    status: r['status'] as RequestStatus,
    emailed: r['emailed'] === 1,
  };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newSecret = (bytes = 24) => randomBytes(bytes).toString('hex');

export interface NewUser {
  email: string;
  name: string;
  role: Role;
  passwordHash: string;
  instructions?: string;
  greeting?: string;
  voice?: string;
}

export type UserPatch = Partial<
  Pick<User, 'name' | 'role' | 'active' | 'instructions' | 'greeting' | 'greetByName' | 'notifyEmail' | 'voice' | 'passwordHash'>
>;

const USER_COLUMNS: Record<keyof UserPatch, string> = {
  name: 'name',
  role: 'role',
  active: 'active',
  instructions: 'instructions',
  greeting: 'greeting',
  greetByName: 'greet_by_name',
  notifyEmail: 'notify_email',
  voice: 'voice',
  passwordHash: 'password_hash',
};

/** All persistence for the management app and the call log. One SQLite file. */
export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  /* --------------------------------- users -------------------------------- */

  countUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  createUser(u: NewUser): User {
    const info = this.db
      .prepare(
        `INSERT INTO users (email, name, role, password_hash, channel_key, channel_secret, instructions, greeting, voice)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(u.email.trim(), u.name.trim(), u.role, u.passwordHash, newSecret(8), newSecret(), u.instructions ?? '', u.greeting ?? '', u.voice ?? '');
    return this.getUser(Number(info.lastInsertRowid))!;
  }

  getUser(id: number): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return r ? toUser(r) : null;
  }

  getUserByEmail(email: string): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as Row | undefined;
    return r ? toUser(r) : null;
  }

  getUserByChannelKey(key: string): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE channel_key = ?').get(key) as Row | undefined;
    return r ? toUser(r) : null;
  }

  /** The owner of the original single-tenant /voice channel: the first admin. */
  getLegacyChannelOwner(): User | null {
    const r = this.db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get() as Row | undefined;
    return r ? toUser(r) : null;
  }

  listUsers(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY id').all() as Row[]).map(toUser);
  }

  updateUser(id: number, patch: UserPatch): User | null {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof UserPatch, unknown][];
    if (entries.length) {
      const sets = entries.map(([k]) => `${USER_COLUMNS[k]} = ?`).join(', ');
      const values = entries.map(([, v]) => (typeof v === 'boolean' ? Number(v) : v));
      this.db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...values, id);
    }
    if (patch.active === false || patch.passwordHash) this.deleteUserSessions(id);
    return this.getUser(id);
  }

  rotateChannelSecret(id: number): User | null {
    this.db.prepare('UPDATE users SET channel_secret = ? WHERE id = ?').run(newSecret(), id);
    return this.getUser(id);
  }

  /* -------------------------------- sessions ------------------------------- */

  /** Returns the raw token for the cookie; only its hash is stored. */
  createSession(userId: number): string {
    const token = newSecret(32);
    const expires = Date.now() + SESSION_DAYS * 86_400_000;
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
    return token;
  }

  getSessionUser(token: string): User | null {
    const r = this.db
      .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1')
      .get(sha256(token), Date.now()) as Row | undefined;
    return r ? toUser(r) : null;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  private deleteUserSessions(userId: number): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  /* -------------------------------- settings ------------------------------- */

  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /* -------------------------------- contacts ------------------------------- */

  listContacts(userId: number): Contact[] {
    return (this.db.prepare('SELECT * FROM contacts WHERE user_id = ? ORDER BY name').all(userId) as Row[]).map(toContact);
  }

  findContactByPhone(userId: number, phone: string): Contact | null {
    const r = this.db.prepare('SELECT * FROM contacts WHERE user_id = ? AND phone = ?').get(userId, phone) as Row | undefined;
    return r ? toContact(r) : null;
  }

  /** Insert, or update the name/notes of the contact with the same phone. */
  upsertContacts(userId: number, rows: { name: string; phone: string; notes?: string }[]): { added: number; updated: number } {
    const find = this.db.prepare('SELECT id FROM contacts WHERE user_id = ? AND phone = ?');
    const insert = this.db.prepare('INSERT INTO contacts (user_id, name, phone, notes) VALUES (?, ?, ?, ?)');
    const update = this.db.prepare('UPDATE contacts SET name = ?, notes = ? WHERE id = ?');
    let added = 0;
    let updated = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        const existing = find.get(userId, r.phone) as { id: number } | undefined;
        if (existing) {
          update.run(r.name, r.notes ?? '', existing.id);
          updated++;
        } else {
          insert.run(userId, r.name, r.phone, r.notes ?? '');
          added++;
        }
      }
    })();
    return { added, updated };
  }

  updateContact(userId: number, id: number, c: { name: string; phone: string; notes: string }): Contact | null {
    this.db.prepare('UPDATE contacts SET name = ?, phone = ?, notes = ? WHERE id = ? AND user_id = ?').run(c.name, c.phone, c.notes, id, userId);
    const r = this.db.prepare('SELECT * FROM contacts WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined;
    return r ? toContact(r) : null;
  }

  deleteContact(userId: number, id: number): boolean {
    return this.db.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  /* -------------------------------- requests ------------------------------- */

  insertRequest(r: Omit<CallRequest, 'id' | 'status' | 'emailed'>): number {
    const info = this.db
      .prepare(
        `INSERT INTO requests (user_id, call_id, caller, contact_name, started_at, duration_ms, answers, transcript, recording)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.userId, r.callId, r.caller, r.contactName, r.startedAt, r.durationMs, JSON.stringify(r.answers), JSON.stringify(r.transcript), r.recording);
    return Number(info.lastInsertRowid);
  }

  markEmailed(id: number): void {
    this.db.prepare('UPDATE requests SET emailed = 1 WHERE id = ?').run(id);
  }

  listRequests(userId: number, status?: RequestStatus, limit = 500): CallRequest[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM requests WHERE user_id = ? AND status = ? ORDER BY started_at DESC LIMIT ?').all(userId, status, limit)
      : this.db.prepare('SELECT * FROM requests WHERE user_id = ? ORDER BY started_at DESC LIMIT ?').all(userId, limit);
    return (rows as Row[]).map(toRequest);
  }

  getRequest(userId: number, id: number): CallRequest | null {
    const r = this.db.prepare('SELECT * FROM requests WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined;
    return r ? toRequest(r) : null;
  }

  setRequestStatus(userId: number, id: number, status: RequestStatus): boolean {
    return this.db.prepare('UPDATE requests SET status = ? WHERE id = ? AND user_id = ?').run(status, id, userId).changes > 0;
  }
}

let store: Store | null = null;

/** Opened on first use, so echo mode and unrelated tests never touch the disk. */
export function getStore(): Store {
  store ??= new Store(config.app.dbPath);
  return store;
}
