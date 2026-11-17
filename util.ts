// Small shared helpers for the forge: pkt-line framing, hashing, base64 and the deterministic
// trial clock. Everything here is pure and dependency-free (Node standard library only).

import { createHash } from 'node:crypto';

/** The all-zero object id: an unborn branch's old/new value in receive-pack commands. */
export const ZERO_OID = '0'.repeat(40);

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte length header. */
export const PKT_LINE_MAX = 65520;

/** SHA-1 of a buffer, as lowercase hex. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Encode one pkt-line data packet: 4 hex length digits (payload + 4) then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_LINE_MAX) throw new Error(`pkt-line payload too large: ${data.length}`);
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

/** The pkt-line flush packet. */
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
/** The pkt-line delimiter packet (protocol v2 section separator). */
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** One decoded pkt-line: a data payload, or one of the control packets. */
export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode a complete pkt-line stream. Throws on a malformed header or a truncated packet;
 * callers that face the network catch and turn it into a protocol error.
 */
export function decodePktLines(bytes: Buffer, offset = 0): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let at = offset;
  while (at < bytes.length) {
    if (at + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const header = bytes.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      at += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (at + length > bytes.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: bytes.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, rest: bytes.subarray(at) };
}

/** Base64 of a UTF-8 string, the contents API's encoding. */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Decode base64 (newlines and spaces ignored, as GitHub wraps content) into raw bytes. */
export function b64decodeBytes(content: string): Buffer {
  return Buffer.from(content.replace(/[\s]+/g, ''), 'base64');
}

/**
 * The forge's clock. A trial must replay byte for byte, so no wall clock is ever read:
 * the base instant comes from MAKEFUN_TRIAL_NOW (the instance's opening time) and every
 * tick advances a counter by one second. Without the variable a fixed epoch is used.
 */
export class TrialClock {
  private current: number;

  constructor(nowIso: string | undefined) {
    const parsed = nowIso === undefined ? Number.NaN : Date.parse(nowIso);
    this.current = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1_700_000_000;
  }

  /** The next timestamp, in unix seconds; every call advances the clock by one second. */
  tick(): number {
    const value = this.current;
    this.current += 1;
    return value;
  }

  /** The current timestamp as an ISO string, without advancing the clock. */
  peekIso(): string {
    return new Date(this.current * 1000).toISOString();
  }

  /** One tick as an ISO string. */
  iso(): string {
    return new Date(this.tick() * 1000).toISOString();
  }
}

/** Format unix seconds as a git timestamp line fragment: `<sec> +0000`. */
export function gitStamp(epochSec: number): string {
  return `${epochSec} +0000`;
}

/** Decode one URL path segment; never throws (a bad escape stays as written). */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
