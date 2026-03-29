/**
 * Mizuchi DB types, loader, and PC-to-function mapping.
 *
 * The Mizuchi DB is a JSON file produced by the Mizuchi decompiler tool,
 * containing function definitions with assembly, optional C code, call
 * relationships, and ROM addresses.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface DecompFunction {
  id: string;
  name: string;
  romAddress?: number;
  cCode?: string;
  cModulePath?: string;
  asmCode: string;
  asmModulePath: string;
  callsFunctions: string[];
}

export interface MizuchiDb {
  version: number;
  platform: string;
  decompFunctions: DecompFunction[];
}

// ─── Loading ────────────────────────────────────────────────────────

const SUPPORTED_VERSION = 1;

/** Strip fields the webapp doesn't need (vectors, indexMetadata). */
function stripMizuchiDb(raw: Record<string, unknown>): MizuchiDb {
  if (raw.version !== SUPPORTED_VERSION) {
    throw new Error(`Unsupported mizuchi-db version: expected ${SUPPORTED_VERSION}, got ${raw.version}`);
  }
  return {
    version: raw.version,
    platform: raw.platform as string,
    decompFunctions: raw.decompFunctions as DecompFunction[],
  };
}

/** Load mizuchi-db.json from a File object (browser file picker). */
export async function loadMizuchiDbFromFile(file: File): Promise<MizuchiDb> {
  const text = await file.text();
  const raw = JSON.parse(text);
  return stripMizuchiDb(raw);
}

/** Fetch mizuchi-db.json from the dev server. */
export async function fetchMizuchiDbFromServer(): Promise<MizuchiDb | null> {
  try {
    const res = await fetch('/api/mizuchiDb');
    if (!res.ok) return null;
    const raw = await res.json();
    return stripMizuchiDb(raw);
  } catch {
    return null;
  }
}

// ─── PC → Function Mapping ──────────────────────────────────────────

export interface FunctionAddressEntry {
  address: number;
  functionId: string;
}

/**
 * Build a sorted index of (romAddress, functionId) pairs for binary search.
 * Only includes functions that have a romAddress.
 */
export function buildAddressIndex(db: MizuchiDb): FunctionAddressEntry[] {
  const entries: FunctionAddressEntry[] = [];
  for (const fn of db.decompFunctions) {
    if (fn.romAddress !== undefined) {
      entries.push({ address: fn.romAddress, functionId: fn.id });
    }
  }
  entries.sort((a, b) => a.address - b.address);
  return entries;
}

/**
 * Given a PC value, find the function that contains it via binary search.
 * A function's range spans from its romAddress to the next function's romAddress.
 * Returns the function ID or null if the PC is outside all known functions.
 */
export function lookupFunctionByPC(addressIndex: FunctionAddressEntry[], pc: number): string | null {
  if (addressIndex.length === 0) return null;

  // Binary search for the largest address <= pc
  let lo = 0;
  let hi = addressIndex.length - 1;

  if (pc < addressIndex[0].address) return null;

  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (addressIndex[mid].address <= pc) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return addressIndex[lo].functionId;
}
