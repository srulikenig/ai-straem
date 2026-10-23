import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { logger } from './logger.js';
import { PbxSession } from './pbx/session.js';
import { CallBridge } from './agent/bridge.js';
import { deliverReport } from './agent/requestReport.js';

/** Constant-time compare, length-safe. */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return false;
  return secretMatches(token.trim(), config.server.authSecret);
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
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true });

  // Handle the upgrade by hand so a bad secret gets a real 401 instead of a
  // socket that opens and then dies for no visible reason.
  http.on('upgrade', (req, socket: Duplex, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== config.server.path) {
      logger.warn({ path: url.pathname }, 'upgrade rejected: unknown path');
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!authorized(req)) {
      logger.warn({ ip: req.socket.remoteAddress }, 'upgrade rejected: bad or missing bearer token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const session = new PbxSession(ws, logger);
    session.log.info({ ip: req.socket.remoteAddress, mode: config.mode }, 'call connected');

    if (config.mode === 'echo') {
      attachEcho(session);
      return;
    }

    const bridge = new CallBridge(session);
    session.on('close', () => bridge.stop());
    session.on('finished', (recordingDir) => void deliverReport(bridge.report(recordingDir), recordingDir, session.log));
    bridge.start().catch((err) => {
      session.log.error({ err }, 'failed to start the model session; ending the call');
      session.endCall();
    });
  });

  http.listen(config.server.port, config.server.host, () => {
    logger.info(
      { host: config.server.host, port: config.server.port, path: config.server.path, tls: useTls, mode: config.mode },
      'listening for PBX streaming connections',
    );
  });

  return http;
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
