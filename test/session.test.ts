import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';

process.env['AUTH_SECRET'] ??= 'x';
process.env['MODE'] = 'echo';
process.env['LOG_LEVEL'] = 'silent';

const { PbxSession } = await import('../src/pbx/session.js');
const { logger } = await import('../src/logger.js');

/** Records what the session sends, with the time it left. */
function fakeWs() {
  const sent: { at: number; binary: boolean; text?: string }[] = [];
  const ws = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    send(data: unknown, opts?: { binary?: boolean }) {
      sent.push({ at: Date.now(), binary: Boolean(opts?.binary), ...(opts?.binary ? {} : { text: String(data) }) });
    },
    close() {
      ws.readyState = 3;
    },
  });
  return { ws: ws as unknown as WebSocket, sent };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('the hangup waits until the closing sentence has played', async () => {
  const { ws, sent } = fakeWs();
  const session = new PbxSession(ws, logger);
  session.play(Buffer.alloc(16 * 400)); // 400 ms of 8 kHz audio still to play
  session.endCall();
  assert.equal(session.closing, true, 'tools see the call as closing at once');

  await sleep(300);
  assert.ok(!sent.some((s) => s.text?.includes('hangup')), 'no hangup while audio is still playing');

  await sleep(1300);
  const hangup = sent.find((s) => s.text?.includes('hangup'));
  const lastFrame = sent.filter((s) => s.binary).at(-1)!;
  assert.ok(hangup, 'hangup sent once playback finished');
  assert.ok(hangup.at - lastFrame.at >= 700, `quiet margin after the last frame: ${hangup.at - lastFrame.at} ms`);

  session.endCall(); // a second final command is refused
  assert.equal(sent.filter((s) => s.text?.includes('hangup')).length, 1);

  const frames = sent.filter((s) => s.binary).length;
  session.play(Buffer.alloc(16 * 200)); // the model starts another goodbye
  await sleep(300);
  assert.equal(sent.filter((s) => s.binary).length, frames, 'nothing new plays after the hangup');
  ws.emit('close', 1000, Buffer.from(''));
});

test('with nothing queued, the hangup goes out after the short quiet margin', async () => {
  const { ws, sent } = fakeWs();
  const session = new PbxSession(ws, logger);
  const start = Date.now();
  session.endCall();
  await sleep(1100);
  const hangup = sent.find((s) => s.text?.includes('hangup'));
  assert.ok(hangup && hangup.at - start < 1100);
  ws.emit('close', 1000, Buffer.from(''));
});
