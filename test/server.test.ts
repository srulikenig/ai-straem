import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import WebSocket from 'ws';

/**
 * End-to-end over a real socket, in echo mode — no model, no API key.
 * Config is read at import time, so the environment is set up first.
 */
const PORT = 8000 + Math.floor(Math.random() * 900);
const SECRET = 'integration-secret';

process.env['AUTH_SECRET'] = SECRET;
process.env['MODE'] = 'echo';
process.env['PORT'] = String(PORT);
process.env['LOG_LEVEL'] = 'silent';
process.env['LOG_PRETTY'] = 'false';

let server: Server;
const url = `ws://127.0.0.1:${PORT}/voice`;

before(async () => {
  const { startServer } = await import('../src/server.js');
  server = startServer();
  await new Promise((r) => server.once('listening', r));
});

after(() => server.close());

function connect(headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

test('rejects a connection with no bearer token', async () => {
  await assert.rejects(() => connect({}), /HTTP 401/);
});

test('rejects a connection with the wrong secret', async () => {
  await assert.rejects(() => connect({ Authorization: 'Bearer nope' }), /HTTP 401/);
});

test('rejects a connection on an unknown path', async () => {
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/wrong`, {
          headers: { Authorization: `Bearer ${SECRET}` },
        });
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
        ws.once('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      }),
    /HTTP 404/,
  );
});

test('accepts the PBX and echoes its audio back, paced', async () => {
  const ws = await connect({ Authorization: `Bearer ${SECRET}` });
  const received: Buffer[] = [];
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) received.push(Buffer.from(data));
  });

  ws.send(JSON.stringify({ type: 'start', call_id: 'itest', caller: '0501234567' }));

  // 10 frames of 20 ms = 200 ms of audio.
  const frame = Buffer.alloc(320, 7);
  for (let i = 0; i < 10; i++) ws.send(frame, { binary: true });

  await new Promise((r) => setTimeout(r, 120));
  const early = received.length;
  assert.ok(early < 10, `paced, not bursted: ${early} frames after 120 ms`);

  await new Promise((r) => setTimeout(r, 250));
  assert.equal(received.length, 10, 'everything arrives eventually');
  assert.ok(received.every((f) => f.length === 320), 'frames keep their exact size');

  ws.close();
});

test('health endpoint answers', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; mode: string; calls: number };
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'echo');
  assert.equal(typeof body.calls, 'number');
});

test('an unknown http path is a 404', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/nope`);
  assert.equal(res.status, 404);
});
