/** Helpers for raw PCM: 16-bit signed, little-endian, mono — the format on both sides. */

export const BYTES_PER_SAMPLE = 2;

export function frameBytes(sampleRate: number, frameMs: number): number {
  return Math.round((sampleRate * frameMs) / 1000) * BYTES_PER_SAMPLE;
}

export function pcm16ToFloat(pcm: Buffer): Float32Array {
  const n = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
  return out;
}

export function floatToPcm16(samples: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    // Clip rather than wrap: a wrapped sample is an audible click.
    const clipped = v > 1 ? 1 : v < -1 ? -1 : v;
    out.writeInt16LE(Math.round(clipped * 32767), i * BYTES_PER_SAMPLE);
  }
  return out;
}

export function silence(sampleRate: number, ms: number): Buffer {
  return Buffer.alloc(Math.round((sampleRate * ms) / 1000) * BYTES_PER_SAMPLE);
}

/** Minimal 44-byte RIFF header — enough to open the dump in any player. */
export function wavHeader(sampleRate: number, dataBytes: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); // PCM chunk size
  h.writeUInt16LE(1, 20); // format = PCM
  h.writeUInt16LE(1, 22); // channels
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28); // byte rate
  h.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export function encodeWav(pcm: Buffer, sampleRate: number): Buffer {
  return Buffer.concat([wavHeader(sampleRate, pcm.length), pcm]);
}

/** A chunk of PCM and when it was heard, in ms from the start of the call. */
export interface TimedPcm {
  atMs: number;
  pcm: Buffer;
}

/**
 * Lays timestamped chunks on one timeline. A chunk goes straight after the
 * previous one unless it came noticeably later, in which case the gap becomes
 * silence — so network jitter never overlaps audio, but real pauses survive.
 */
export function layTrack(chunks: readonly TimedPcm[], sampleRate: number, slackMs = 100): Buffer {
  const bytesAt = (ms: number) => Math.max(0, Math.round((ms * sampleRate) / 1000)) * BYTES_PER_SAMPLE;
  const slack = bytesAt(slackMs);
  const placed: { offset: number; pcm: Buffer }[] = [];
  let cursor = 0;
  for (const { atMs, pcm } of chunks) {
    const due = bytesAt(atMs);
    if (due - cursor > slack) cursor = due;
    placed.push({ offset: cursor, pcm });
    cursor += pcm.length;
  }
  const out = Buffer.alloc(cursor);
  for (const { offset, pcm } of placed) pcm.copy(out, offset);
  return out;
}

/** Sums two tracks sample by sample; the shorter one counts as silence. */
export function mixPcm(a: Buffer, b: Buffer): Buffer {
  const samples = Math.floor(Math.max(a.length, b.length) / BYTES_PER_SAMPLE);
  const out = Buffer.alloc(samples * BYTES_PER_SAMPLE);
  const at = (buf: Buffer, off: number) => (off + 1 < buf.length ? buf.readInt16LE(off) : 0);
  for (let off = 0; off < out.length; off += BYTES_PER_SAMPLE) {
    const s = at(a, off) + at(b, off);
    out.writeInt16LE(s > 32767 ? 32767 : s < -32768 ? -32768 : s, off);
  }
  return out;
}

export interface DecodedWav {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
}

/** Reads 16-bit PCM wav files; chunk-walks so it survives a LIST/fact chunk. */
export function decodeWav(buf: Buffer): DecodedWav {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let pos = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  let pcm: Buffer | null = null;

  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      pcm = buf.subarray(body, Math.min(body + size, buf.length));
    }
    pos = body + size + (size % 2); // chunks are word-aligned
  }

  if (!pcm || !sampleRate) throw new Error('wav is missing fmt or data chunk');
  if (bits !== 16) throw new Error(`only 16-bit wav is supported, got ${bits}-bit`);
  return { pcm, sampleRate, channels };
}
