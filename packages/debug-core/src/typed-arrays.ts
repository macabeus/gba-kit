/**
 * The typed-array kinds a machine snapshot holds, named once so deltas and save
 * states agree on how each is flattened to bytes and rebuilt. A kind nobody
 * listed fails loudly instead of being walked as a plain object and silently
 * mangled into `{ "0": …, "1": … }`.
 */

export type ArrayKind = 'u8' | 'u32' | 'i8' | 'f32';

/** The kind of a typed array, or null for anything that is not one. Throws for a view of an unlisted kind. */
export function arrayKind(v: unknown): ArrayKind | null {
  if (v instanceof Uint8Array) {
    return 'u8';
  }
  if (v instanceof Uint32Array) {
    return 'u32';
  }
  if (v instanceof Int8Array) {
    return 'i8';
  }
  if (v instanceof Float32Array) {
    return 'f32';
  }
  if (ArrayBuffer.isView(v)) {
    throw new Error(`unsupported typed array ${v.constructor.name} in a snapshot`);
  }
  return null;
}

/** The bytes behind any typed array, without copying. */
export function viewBytes(v: ArrayBufferView): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/** A fresh array of `kind` over a copy of `bytes` (own, aligned buffer). */
export function arrayFrom(kind: ArrayKind, bytes: Uint8Array): ArrayBufferView {
  const copy = bytes.slice();
  switch (kind) {
    case 'u32':
      return new Uint32Array(copy.buffer, 0, copy.byteLength >> 2);
    case 'i8':
      return new Int8Array(copy.buffer, 0, copy.byteLength);
    case 'f32':
      return new Float32Array(copy.buffer, 0, copy.byteLength >> 2);
    default:
      return copy;
  }
}
