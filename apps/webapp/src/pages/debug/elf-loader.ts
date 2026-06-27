/**
 * Load DWARF/symbol debug info from a (`-g`-built) ELF picked by the user.
 *
 * Read as an ArrayBuffer (the ELF is binary). The shipped `.gba` has no debug
 * info (objcopy strips it) — point
 * the picker at the sidecar `klonoa-eod.elf` / `balatro-gba.elf`, whose loadable
 * bytes match the ROM so addresses line up.
 */
import { DebugInfo } from '@gba-kit/debug-info';

/** Parse an ELF File (from the browser file picker) into DebugInfo. */
export async function loadDebugInfoFromFile(file: File): Promise<DebugInfo> {
  const buf = await file.arrayBuffer();
  return DebugInfo.fromElf(new Uint8Array(buf));
}

/** Fetch + parse the sidecar ELF the dev server serves at /api/loadElf. */
export async function loadDebugInfoFromServer(): Promise<DebugInfo> {
  const res = await fetch('/api/loadElf');
  if (!res.ok) {
    throw new Error(`Failed to load ELF from server: ${res.statusText}`);
  }
  return DebugInfo.fromElf(new Uint8Array(await res.arrayBuffer()));
}
