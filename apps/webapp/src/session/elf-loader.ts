/**
 * Get the bytes of a (`-g`-built) ELF: picked by the user, or served by the dev
 * server. The shipped `.gba` has no debug info (objcopy strips it); the sidecar
 * ELF's loadable bytes match the ROM, so addresses line up.
 */

export async function readElfFile(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export async function fetchElfFromServer(): Promise<Uint8Array> {
  const res = await fetch('/api/loadElf');
  if (!res.ok) {
    throw new Error(`Failed to load ELF from server: ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
