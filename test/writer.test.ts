import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { PbxWriter } from '../src/pbx/writer.js';
import { hangupCommand, clearCommand, transferExtensionCommand } from '../src/pbx/protocol.js';
import { logger } from '../src/logger.js';

const FRAME_BYTES = 320; // 20 ms of 8 kHz PCM16
const log = logger.child({ test: true });

interface Sent {
  binary: boolean;
  data: string | number;
}

function fakeWs(): { ws: WebSocket; sent: Sent[] } {
  const sent: Sent[] = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    send(data: unknown, opts?: { binary?: boolean }) {
      sent.push(
        opts?.binary
          ? { binary: true, data: (data as Buffer).length }
          : { binary: false, data: String(data) },
      );
    },
  };
  return { ws: ws as unknown as WebSocket, sent };
}

function writer(ws: WebSocket): PbxWriter {
  return new PbxWriter(ws, { frameBytes: FRAME_BYTES, frameMs: 20, queueWarnMs: 15000, log });
}

test('splits audio into exact frames and carries the remainder', () => {
  const { ws } = fakeWs();
  const w = writer(ws);
  w.enqueueAudio(Buffer.alloc(FRAME_BYTES * 2 + 100));
  assert.equal(w.queuedMs, 20 * 2 + (100 / FRAME_BYTES) * 20);
  w.enqueueAudio(Buffer.alloc(FRAME_BYTES - 100)); // completes the third frame
  assert.equal(w.queuedMs, 60);
});

test('paces audio instead of flushing the queue at once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { ws, sent } = fakeWs();
  const w = writer(ws);

  w.enqueueAudio(Buffer.alloc(FRAME_BYTES * 5)); // 100 ms of audio
  w.start();
  assert.equal(sent.filter((s) => s.binary).length, 1, 'only the first frame leaves immediately');

  t.mock.timers.tick(20);
  assert.equal(sent.filter((s) => s.binary).length, 2);

  t.mock.timers.tick(60);
  assert.equal(sent.filter((s) => s.binary).length, 5, 'all five frames after 100 ms, not before');

  t.mock.timers.tick(200);
  assert.equal(sent.filter((s) => s.binary).length, 5, 'nothing invented once the queue drains');
  w.stop();
  mock.timers.reset();
});

test('commands leave ahead of the audio queued behind them', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { ws, sent } = fakeWs();
  const w = writer(ws);
  w.start();

  w.enqueueAudio(Buffer.alloc(FRAME_BYTES * 3));
  w.sendCommand(clearCommand());
  t.mock.timers.tick(20);

  const first = sent.findIndex((s) => !s.binary);
  const firstAudioAfter = sent.findIndex((s, i) => s.binary && i > first);
  assert.ok(first >= 0, 'the command was sent');
  assert.ok(firstAudioAfter > first, 'audio follows the command in the same tick');
  w.stop();
  mock.timers.reset();
});

test('only one final command is ever sent', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { ws, sent } = fakeWs();
  const w = writer(ws);
  w.start();

  w.sendCommand(transferExtensionCommand('/2'));
  w.sendCommand(hangupCommand()); // must be refused
  t.mock.timers.tick(40);

  const commands = sent.filter((s) => !s.binary).map((s) => JSON.parse(String(s.data)));
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'transfer_extension');
  assert.equal(w.finalSent, true);
  w.stop();
  mock.timers.reset();
});

test('barge-in drops everything still queued', () => {
  const { ws } = fakeWs();
  const w = writer(ws);
  w.enqueueAudio(Buffer.alloc(FRAME_BYTES * 10));
  assert.equal(w.queuedMs, 200);
  assert.equal(w.dropQueuedAudio(), 200);
  assert.equal(w.queuedMs, 0);
});

test('a stalled event loop is caught up, but the burst is capped', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { ws, sent } = fakeWs();
  const w = writer(ws);
  w.enqueueAudio(Buffer.alloc(FRAME_BYTES * 50));
  w.start();
  sent.length = 0;

  // One timer firing after a 1-second stall must not empty the whole queue.
  t.mock.timers.tick(1000);
  const frames = sent.filter((s) => s.binary).length;
  assert.ok(frames <= 50, 'never more than the queue holds');
  assert.ok(frames < 50, `capped the catch-up burst, sent ${frames}`);
  w.stop();
  mock.timers.reset();
});
