import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from './config.js';
import { logger } from './logger.js';
import { PbxSession } from './pbx/session.js';
import { CallBridge, type CallProfile } from './agent/bridge.js';
import { deliverReport } from './agent/requestReport.js';
import { composeSystemPrompt, globalPrompt, openingNudge } from './agent/prompt.js';
import { getStore, type User } from './db.js';
import { normalizePhone } from './contacts.js';
import { handleWeb } from './web/app.js';

/** How long to wait for the PBX `start` message (it carries the caller id) before starting anyway. */
const START_WAIT_MS = 3000;

/** Constant-time compare, length-safe. */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token.trim() : null;
}

/**
 * For the rejection log: what was presented, without ever logging the secret.
 * Pasting another line's secret into a new PBX channel is the usual mistake,
 * so say whose secret it was.
 */
function describeToken(token: string | null): Record<string, unknown> {
  if (!token) return { presented: 'none' };
  const owner =
    config.mode === 'bot' ? getStore().listUsers().find((u) => secretMatches(token, u.channelSecret)) : undefined;
  return {
    presentedLength: token.length,
    matches: secretMatches(token, config.server.authSecret)
      ? 'AUTH_SECRET (the /voice channel)'
      : owner
        ? `the channel secret of user ${owner.id} (${owner.email})`
        : 'nothing known',
  };
}

/**
 * Which line a PBX connection belongs to. Each user has their own channel,
 * /voice/<key> with its own secret. The original single channel, /voice with
 * AUTH_SECRET, still works and belongs to the first admin.
 */
function resolveChannel(pathname: string): { owner: User | null; secret: string } | null {
  const base = config.server.path;
  if (pathname === base) {
    return { owner: config.mode === 'bot' ? getStore().getLegacyChannelOwner() : null, secret: config.server.authSecret };
  }
  if (!pathname.startsWith(`${base}/`)) return null;
  const user = getStore().getUserByChannelKey(pathname.slice(base.length + 1));
  return user?.active ? { owner: user, secret: user.channelSecret } : null;
}

function callProfile(owner: User, caller: string | null): CallProfile {
  const store = getStore();
  const fresh = store.getUser(owner.id) ?? owner; // pick up settings saved since the socket opened
  const phone = caller ? normalizePhone(caller) : null;
  const contact = phone ? store.findContactByPhone(fresh.id, phone) : null;
  const ctx = { caller, contact };
  return {
    owner: fresh,
    contact,
    systemPrompt: composeSystemPrompt(globalPrompt(store), fresh, ctx),
    opening: openingNudge(fresh, ctx),
    voice: fresh.voice || config.gemini.voice,
  };
}

export function startServer(): Server {
  const useTls = Boolean(config.server.tlsCertPath && config.server.tlsKeyPath);
  const http = useTls
    ? createHttpsServer({
        cert: readFileSync(config.server.tlsCertPath!),
        key: readFileSync(config.server.tlsKeyPath!),
      })
    : createHttpServer();

  // A plain GET is handy for an uptime check; the PBX only ever upgrades.
  http.on('request', (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: config.mode, calls: wss.clients.size }));
      return;
    }
    void handleWeb(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });

  // Handle the upgrade by hand so a bad secret gets a real 401 instead of a
  // socket that opens and then dies for no visible reason.
  http.on('upgrade', (req, socket: Duplex, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const channel = resolveChannel(url.pathname);
    if (!channel) {
      logger.warn({ path: url.pathname }, 'upgrade rejected: unknown path');
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = bearer(req);
    if (!token || !secretMatches(token, channel.secret)) {
      logger.warn(
        { ip: req.socket.remoteAddress, path: url.pathname, expectedLength: channel.secret.length, ...describeToken(token) },
        'upgrade rejected: bad or missing bearer token',
      );
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onCall(ws, req, channel.owner));
  });

  http.listen(config.server.port, config.server.host, () => {
    logger.info(
      { host: config.server.host, port: config.server.port, path: config.server.path, tls: useTls, mode: config.mode },
      'listening for PBX streaming connections',
    );
  });

  return http;
}

function onCall(ws: WebSocket, req: IncomingMessage, owner: User | null): void {
  const session = new PbxSession(ws, logger);
  session.log.info({ ip: req.socket.remoteAddress, mode: config.mode, owner: owner?.id ?? null }, 'call connected');

  if (config.mode === 'echo' || !owner) {
    attachEcho(session);
    return;
  }

  // The prompt depends on who is calling, and the caller id arrives in
  // `start`, so the model session opens only once that message is in.
  let bridge: CallBridge | null = null;
  const begin = () => {
    clearTimeout(fallback);
    if (bridge || session.closing) return;
    bridge = new CallBridge(session, callProfile(owner, session.caller));
    bridge.start().catch((err) => {
      session.log.error({ err }, 'failed to start the model session; ending the call');
      session.endCall();
    });
  };
  const fallback = setTimeout(begin, START_WAIT_MS);
  session.once('start', begin);
  session.on('close', () => {
    clearTimeout(fallback);
    bridge?.stop();
  });
  session.on('finished', (recordingDir) => {
    if (bridge) void deliverReport(bridge.report(recordingDir), recordingDir, owner, session.log);
  });
}

/**
 * Phase-zero mode: play the caller's own voice back, through the same pacing
 * writer the real path uses. Proves auth, framing, pacing and the socket
 * lifecycle without spending a cent on the model.
 */
function attachEcho(session: PbxSession): void {
  session.on('start', () => session.log.info('echo mode: looping caller audio back'));
  session.on('audio', (pcm) => session.play(pcm));
}
