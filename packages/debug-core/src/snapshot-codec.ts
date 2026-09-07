/**
 * `GbaSnapshot` ⇄ JSON, with typed arrays as base64. Works in Node and browsers
 * (no `Buffer`), and is the on-disk format of a save state.
 */
import type { GbaSnapshot } from '@gba-kit/gba-emulator/savestate';

import type { ScreenJson } from './ppu.js';
import { type ArrayKind, arrayFrom, arrayKind, viewBytes } from './typed-arrays.js';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) {
  B64_INDEX[B64.charCodeAt(i)] = i;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  if (i < bytes.length) {
    const rest = bytes.length - i;
    const n = (bytes[i]! << 16) | (rest > 1 ? bytes[i + 1]! << 8 : 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (rest > 1 ? B64[(n >> 6) & 63]! : '=') + '=';
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const a = B64_INDEX[clean.charCodeAt(i)]!;
    const b = B64_INDEX[clean.charCodeAt(i + 1)]!;
    const c = i + 2 < clean.length ? B64_INDEX[clean.charCodeAt(i + 2)]! : -1;
    const d = i + 3 < clean.length ? B64_INDEX[clean.charCodeAt(i + 3)]! : -1;
    out[o++] = (a << 2) | (b >> 4);
    if (c >= 0) {
      out[o++] = ((b & 15) << 4) | (c >> 2);
    }
    if (d >= 0) {
      out[o++] = ((c & 3) << 6) | d;
    }
  }
  return out.subarray(0, o);
}

type Json = Record<string, unknown>;

/** Deep copy with every typed array replaced by `{ $t: 'u8'|'u32'|'i8'|'f32', $b: base64 }`. */
export function encodeTypedArrays(value: unknown): unknown {
  const kind = arrayKind(value);
  if (kind !== null) {
    return { $t: kind, $b: bytesToBase64(viewBytes(value as ArrayBufferView)) };
  }
  if (Array.isArray(value)) {
    return value.map(encodeTypedArrays);
  }
  if (value && typeof value === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = encodeTypedArrays(v);
    }
    return out;
  }
  return value;
}

export function decodeTypedArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeTypedArrays);
  }
  if (value && typeof value === 'object') {
    const o = value as Json;
    if (typeof o.$t === 'string' && typeof o.$b === 'string') {
      return arrayFrom(o.$t as ArrayKind, base64ToBytes(o.$b));
    }
    const out: Json = {};
    for (const [k, v] of Object.entries(o)) {
      out[k] = decodeTypedArrays(v);
    }
    return out;
  }
  return value;
}

/** The save-state file: a JSON document with a format tag, a ROM identity and the snapshot. */
export interface SaveStateFile {
  format: 'gba-kit-savestate';
  version: 1;
  /** SHA-256 hex of the ROM the state belongs to, when known */
  romHash?: string;
  name?: string;
  createdAt: string;
  frame: number;
  /** the screen at the moment it was saved, for a view that lists states */
  thumbnail?: ScreenJson;
  snapshot: unknown;
}

/**
 * A save state as text. The metadata keys come before `snapshot`: a reader listing
 * states parses the head of the file up to `,"snapshot":` instead of the whole snapshot.
 */
export function encodeSaveState(
  snapshot: GbaSnapshot,
  meta: { romHash?: string; name?: string; frame: number; thumbnail?: SaveStateFile['thumbnail'] },
): string {
  const file: SaveStateFile = {
    format: 'gba-kit-savestate',
    version: 1,
    romHash: meta.romHash,
    name: meta.name,
    createdAt: new Date().toISOString(),
    frame: meta.frame,
    thumbnail: meta.thumbnail,
    snapshot: encodeTypedArrays(snapshot),
  };
  return JSON.stringify(file);
}

/**
 * A save state's metadata, from the whole file or from a head that reaches at least
 * `,"snapshot":`, so a listing skips the snapshot that follows. Null when what came
 * back is not JSON.
 */
export function saveStateMeta(text: string): Omit<SaveStateFile, 'snapshot'> | null {
  const snapshotAt = text.indexOf(',"snapshot":');
  try {
    return JSON.parse(snapshotAt >= 0 ? text.slice(0, snapshotAt) + '}' : text) as Omit<SaveStateFile, 'snapshot'>;
  } catch {
    return null;
  }
}

/** The same state under another name, without decoding its snapshot. */
export function renameSaveState(text: string, name: string): string {
  const file = JSON.parse(text) as SaveStateFile;
  if (file.format !== 'gba-kit-savestate') {
    throw new Error('not a gba-kit save state');
  }
  const { snapshot, ...meta } = file;
  return JSON.stringify({ ...meta, name, snapshot });
}

export function decodeSaveState(text: string): { snapshot: GbaSnapshot; meta: Omit<SaveStateFile, 'snapshot'> } {
  const file = JSON.parse(text) as SaveStateFile;
  if (file.format !== 'gba-kit-savestate') {
    throw new Error('not a gba-kit save state');
  }
  const { snapshot, ...meta } = file;
  return { snapshot: decodeTypedArrays(snapshot) as GbaSnapshot, meta };
}
