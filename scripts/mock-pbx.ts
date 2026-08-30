/**
 * Stands in for the PBX so the whole pipeline can be exercised without a phone
 * line: it dials our own websocket, speaks the same protocol, streams 8 kHz
 * audio at real-time rate, prints every command it receives, and saves the
 * bot's reply as a wav you can listen to.
 *
 *   npm run mock -- --audio caller.wav --dtmf 5@6s --hangup 40s
 *
 * The wav may be at any sample rate; it is converted to 8 kHz mono on the way.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import WebSocket from 'ws';
import { decodeWav, encodeWav, floatToPcm16, frameBytes, pcm16ToFloat, silence } from '../src/audio/pcm.js';
import { Resampler } from '../src/audio/resample.js';
import { rmsDbfs } from '../src/audio/level.js';

const args = parseArgs(process.argv.slice(2));
const url = args['url'] ?? 'ws://127.0.0.1:8080/voice';
const secret = args['secret'] ?? process.env.AUTH_SECRET ?? '';
const audioPath = args['audio'] ?? null;
const outPath = args['out'] ?? 'tmp/mock-bot-reply.wav';
const callId = args['call-id'] ?? `mock-${Date.now()}`;
const caller = args['caller'] ?? '0501234567';
const extension = args['extension'] ?? '/8';
const frameMs = Number(args['frame-ms'] ?? 20);
const RATE = 8000;
const FRAME_BYTES = frameBytes(RATE, frameMs);

if (!secret) {
  console.error('missing --secret (or AUTH_SECRET in the environment)');
  process.exit(1);
}

const outbound = audioPath ? loadAsPcm8k(audioPath) : silence(RATE, 5000);
const received: Buffer[] = [];
const commands: unknown[] = [];

const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${secret}` } });

ws.on('open', () => {
  console.log(`→ connected to ${url}`);
  send({ type: 'start', call_id: callId, caller, extension });

  scheduleTimed(args['dtmf'], (value) => {
    console.log(`→ dtmf ${value}`);
    send({ type: 'dtmf', digit: value });
  });
  scheduleTimed(args['hangup'], () => {
    console.log('→ hangup');
    send({ type: 'hangup' });
    setTimeout(() => ws.close(), 300);
  });

  streamAudio();
});

ws.on('message', (data: Buffer, isBinary: boolean) => {
  if (isBinary) {
    received.push(Buffer.from(data));
    return;
  }
  const text = data.toString('utf8');
  console.log(`← ${text}`);
  try {
    commands.push(JSON.parse(text));
  } catch {
    commands.push({ unparseable: text });
  }
});

ws.on('close', (code, reason) => {
  console.log(`× closed (${code}) ${reason.toString()}`);
  finish();
});
ws.on('error', (err) => {
  console.error('socket error:', err.message);
  process.exitCode = 1;
});

/** Real-time pacing in both directions — a burst would not test anything real. */
function streamAudio(): void {
  let off = 0;
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return clearInterval(timer);
    if (off >= outbound.length) {
      clearInterval(timer);
      console.log('→ caller audio finished; holding the line');
      return;
    }
    const frame = outbound.subarray(off, off + FRAME_BYTES);
    off += FRAME_BYTES;
    ws.send(frame, { binary: true });
  }, frameMs);
}

function finish(): void {
  const pcm = Buffer.concat(received);
  const seconds = pcm.length / (RATE * 2);
  console.log('');
  console.log(`bot audio received: ${seconds.toFixed(2)}s  (${pcm.length} bytes)`);
  if (pcm.length) console.log(`level: ${rmsDbfs(pcm).toFixed(1)} dBFS`);
  console.log(`commands received: ${commands.length}`);
  for (const c of commands) console.log('  ' + JSON.stringify(c));
  if (pcm.length) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, encodeWav(pcm, RATE));
    console.log(`wrote ${outPath}`);
  }
  process.exit(0);
}

function send(obj: unknown): void {
  ws.send(JSON.stringify(obj));
}

/** "5@6s" -> fire with value "5" after 6 seconds. Bare "40s" -> no value. */
function scheduleTimed(spec: string | undefined, fn: (value: string) => void): void {
  if (!spec) return;
  const [value, at] = spec.includes('@') ? spec.split('@') : ['', spec];
  const ms = parseDuration(at ?? '0');
  setTimeout(() => fn(value ?? ''), ms);
}

function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(s.trim());
  if (!m) throw new Error(`bad duration: ${s}`);
  const n = Number(m[1]);
  return m[2] === 'ms' ? n : m[2] === 'm' ? n * 60_000 : n * 1000;
}

function loadAsPcm8k(path: string): Buffer {
  const wav = decodeWav(readFileSync(path));
  let pcm = wav.pcm;
  if (wav.channels > 1) pcm = toMono(pcm, wav.channels);
  if (wav.sampleRate !== RATE) {
    pcm = new Resampler(wav.sampleRate, RATE).processPcm(pcm);
    console.log(`converted ${path}: ${wav.sampleRate} Hz -> ${RATE} Hz`);
  }
  return pcm;
}

function toMono(pcm: Buffer, channels: number): Buffer {
  const frames = Math.floor(pcm.length / 2 / channels);
  const out = new Float32Array(frames);
  const src = pcm16ToFloat(pcm);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += src[i * channels + c] ?? 0;
    out[i] = sum / channels;
  }
  return floatToPcm16(out);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}
