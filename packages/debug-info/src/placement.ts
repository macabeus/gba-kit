/**
 * What the program says about one address: which object holds it, how much of that
 * the ELF and the DWARF actually state, and — where a type reaches it — the member
 * path that names it (`gEntityInfo[13].xPosBg2`).
 *
 * This is the inverse of resolving an expression. An expression walks a type
 * downward from a name the user typed; a memory diff arrives with an address and
 * nothing else, and has to walk the same type to find what lives there.
 *
 * The tiers exist because the answer is often a guess, and a guess presented as a
 * name is worse than no name at all. `addressToSymbol` answers for any address at
 * all: with no symbol covering it, it names the nearest one below, however far away
 * and whatever memory that one is in. On a decomp's ELF that reaches absurd
 * distances — a linker-placed `SHN_ABS` constant at address 4 is the nearest symbol
 * below every byte of EWRAM — so an address is only attributed to a symbol that is
 * in the same memory region, and only called `sized` when something declared an
 * extent that covers it.
 */
import type { DebugInfo } from './debug-info.js';
import { type MemberDesc, type TypeDesc, bitfieldPlacement } from './dwarf/values.js';

/** How much the program states about an address, and how much of that is stated rather than guessed. */
export type Tier = 'sized' | 'inferred' | 'unattributed';

export interface Placement {
  address: number;
  tier: Tier;
  /** the object it is claimed to be in, with the claim's own strength in `tier` */
  symbol?: { name: string; base: number; offset: number };
  /** `gEntityInfo[13].xPosBg2`, symbol included — only when a DWARF type reached the address */
  path?: string;
  /** the type the path ends at, so a value reads the way the variables tree reads it */
  type?: TypeDesc;
  /**
   * Where that type begins, which is where it is read from: an address inside an
   * object is not the object's start. For a bitfield it is the start of the struct
   * holding it, which is what `bitfieldPlacement`'s `byteOffset` is measured from.
   */
  base?: number;
  /** the member the path ends at when it is a bitfield: what `bitfieldPlacement` needs */
  member?: MemberDesc;
  /** the other members of a union covering these bytes, since no one reading is the reading */
  alternatives?: string[];
  /** the read crosses out of `type` into whatever follows it */
  straddles?: boolean;
  /** the walk went past a declared bound (an unsized `extern T x[]`), so the path is a hypothesis */
  extrapolated?: boolean;
}

/** How deep a path may go before a self-referential type is what is being walked. */
const MAX_DEPTH = 16;

/**
 * Which memory an address is in, by its top byte — the bus's own division, and all
 * that is needed to tell a symbol that could plausibly cover an address from one
 * that is 33 MB away in another memory.
 */
function regionKey(address: number): number {
  return (address >>> 24) & 0xff;
}

/**
 * The declared type of a global, preferring the definition and falling back to an
 * `extern` declaration. Remembered per ELF, because finding one walks every compilation
 * unit's globals and a memory diff asks for thousands of addresses in a row.
 */
const declaredTypes = new WeakMap<DebugInfo, Map<string, TypeDesc | null>>();

function declaredType(info: DebugInfo, name: string): TypeDesc | null {
  if (!info.hasTypeInfo) {
    return null;
  }
  let known = declaredTypes.get(info);
  if (!known) {
    known = new Map();
    declaredTypes.set(info, known);
  }
  const cached = known.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const scopes = info.scopes;
  const entry = scopes.globalByName(name) ?? scopes.declarationByName(name);
  const type = entry ? scopes.types.describeDeclared(entry) : null;
  known.set(name, type);
  return type;
}

/**
 * The bytes of a struct a member occupies, from the struct's own start. A bitfield
 * occupies the bytes its bits fall in rather than its whole storage type, which is
 * what tells four bitfields packed into one word apart; a member the DWARF gives no
 * size at all (a zero-length trailing array) occupies the one byte it begins at,
 * since an address can still land on it.
 */
function extentOf(member: MemberDesc): { lo: number; hi: number } {
  const bits = bitfieldPlacement(member);
  if (bits) {
    return { lo: bits.byteOffset, hi: bits.byteOffset + bits.bits.span };
  }
  return { lo: member.offset, hi: member.offset + Math.max(1, member.type.size || 1) };
}

function width(member: MemberDesc): number {
  const at = extentOf(member);
  return at.hi - at.lo;
}

interface Walk {
  path: string;
  leaf: TypeDesc;
  /** what is left of the offset once the walk stopped: the leaf begins that far before the address */
  remainder: number;
  member?: MemberDesc;
  alternatives?: string[];
  straddles: boolean;
  extrapolated: boolean;
}

/**
 * The member or element at `offset` inside `type`, as the path to it.
 *
 * An array whose length the DWARF never stated (`extern T x[]`, which is how a
 * decomp declares a fixed-address table) is still descended into, because element 13
 * of it is a real place, but the result says the bound was extrapolated: nothing in
 * the program vouches for there being fourteen elements.
 *
 * A read wider than the member it lands in is not that member: the walk stops at the
 * innermost type that covers the whole span and says the read straddles, so a 32-bit
 * row over a `u16` field reads as the two halfwords at the struct rather than as the
 * field.
 */
export function pathTo(type: TypeDesc, offset: number, size: number): Walk {
  let path = '';
  let leaf = type;
  let off = offset;
  /** only a bitfield ends a walk holding one: it is what tells the reader which bits to take */
  let member: MemberDesc | undefined;
  let alternatives: string[] | undefined;
  let extrapolated = false;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (leaf.kind === 'array' && leaf.target) {
      const stride = leaf.target.size || 1;
      const index = Math.floor(off / stride);
      if (leaf.count !== null && leaf.count !== undefined && index >= leaf.count) {
        extrapolated = true;
        break;
      }
      if (leaf.count === null) {
        extrapolated = true;
      }
      path += `[${index}]`;
      off -= index * stride;
      leaf = leaf.target;
      continue;
    }
    if ((leaf.kind === 'struct' || leaf.kind === 'union') && leaf.members?.length) {
      const covering = leaf.members.filter((m) => {
        const at = extentOf(m);
        return off >= at.lo && off < at.hi;
      });
      if (covering.length === 0) {
        break;
      }
      // a union's members overlap by construction, so the first covering one is the
      // reading offered and the rest are named as the others it could be. A struct's do
      // not, except where bitfields share a storage byte and where a zero-length
      // trailing array sits on the byte after the last real member, so the narrowest
      // covering member is the one the address is actually in.
      const m =
        leaf.kind === 'union'
          ? covering[0]!
          : covering.reduce((best, other) => (width(other) < width(best) ? other : best));
      if (leaf.kind === 'union' && covering.length > 1) {
        alternatives = covering.slice(1).map((other) => other.name);
      }
      path += `.${m.name}`;
      if (m.bitSize !== undefined) {
        return { path, leaf: m.type, remainder: off, member: m, alternatives, straddles: false, extrapolated };
      }
      off -= m.offset;
      leaf = m.type;
      continue;
    }
    break;
  }
  return { path, leaf, remainder: off, member, alternatives, straddles: off + size > (leaf.size || 1), extrapolated };
}

/**
 * What the program says holds `address`, for a read of `size` bytes there.
 *
 * `sized` needs a declared extent covering the address: an `st_size` the assembler
 * wrote, or a DWARF type whose own size covers the offset without the walk having
 * passed an unstated array bound. Everything else a symbol in the same memory claims
 * is `inferred` — usable as a landmark, never as a name — and an address no symbol
 * of its own memory reaches is `unattributed`, which on a decomp is where the
 * interesting variables usually are.
 */
export function placementAt(info: DebugInfo, address: number, size: 1 | 2 | 4): Placement {
  const near = info.symbols.addressToSymbol(address);
  if (!near || regionKey(address - near.offset) !== regionKey(address)) {
    return { address, tier: 'unattributed' };
  }
  const base = address - near.offset;
  const symbol = { name: near.name, base, offset: near.offset };
  const type = declaredType(info, near.name);
  const stSize = info.symbolSize(near.name) ?? 0;
  if (!type) {
    return { address, tier: near.exact ? 'sized' : 'inferred', symbol };
  }
  const walk = pathTo(type, near.offset, size);
  const declared = (stSize > 0 && near.offset < stSize) || (type.size > 0 && near.offset < type.size);
  const tier: Tier = near.exact || (declared && !walk.extrapolated) ? 'sized' : 'inferred';
  return {
    address,
    tier,
    symbol,
    path: near.name + walk.path,
    type: walk.leaf,
    base: address - walk.remainder,
    member: walk.member,
    alternatives: walk.alternatives,
    straddles: walk.straddles || undefined,
    extrapolated: walk.extrapolated || undefined,
  };
}
