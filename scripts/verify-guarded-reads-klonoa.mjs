/**
 * End-to-end check of the guarded read surface against a real, non-trivial game.
 *
 * The unit tests in packages/gba-emulator pin the behaviour on synthetic memory. This
 * runs the same guarantees against Klonoa: Empire of Dreams (agbcc / GBA Thumb) and
 * its decomp's DWARF, because that is the corpus the defect was reported from and
 * because a struct laid out by a real compiler is what produced the odd-offset member
 * that started this. Every address and offset below is resolved from the build's own
 * ELF; nothing is hand-typed.
 *
 * It needs a local decomp checkout with `make` already run, so it is NOT part of `pnpm
 * test` — CI has neither the ROM nor the toolchain:
 *
 *     pnpm build
 *     KLONOA_ROOT=../klonoa-empire-of-dreams node scripts/verify-guarded-reads-klonoa.mjs
 *
 * Exits non-zero if any check fails.
 */
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const KLONOA_ROOT = process.env.KLONOA_ROOT;
if (!KLONOA_ROOT) {
  console.error('Set KLONOA_ROOT to a kl-eod decomp checkout that has been built (`make`).');
  process.exit(2);
}
const REPO = resolve(KLONOA_ROOT);
const ROM = `${REPO}/baserom.gba`;
const ELF = `${REPO}/klonoa-eod.elf`;
const SAVESTATE = process.env.GBA_KIT_SAVESTATE ?? `${ROOT}/klonoa-analysis/savestate-in-level-idle.json`;

for (const [what, path] of [
  ['ROM', ROM],
  ['ELF', ELF],
  ['savestate', SAVESTATE],
]) {
  if (!fs.existsSync(path)) {
    console.error(`Missing ${what}: ${path}`);
    process.exit(2);
  }
}

const { HeadlessRuntime } = await import(pathToFileURL(`${ROOT}/packages/gba-node/dist/index.js`).href);
const { DebugInfo } = await import(pathToFileURL(`${ROOT}/packages/debug-info/dist/index.js`).href);

const rt = await HeadlessRuntime.create({
  romPath: ROM,
  elfPath: ELF,
  outputDir: fs.mkdtempSync('/tmp/gba-kit-verify-'),
  logFn: () => {},
});
await rt.engine.loadState(SAVESTATE);
const engine = rt.engine;
const bus = rt.gba.bus;
const di = DebugInfo.fromElf(new Uint8Array(fs.readFileSync(ELF)));

let failures = 0;
function check(label, ok, failDetail = '') {
  if (!ok) {
    failures++;
  }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && failDetail ? ` — ${failDetail}` : ''}`);
}
function threw(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e.message;
  }
}

// The decomp's own helper, copied verbatim from its
// docs/dynamic-analysis/scripts/_harness.mjs — this is the code that was reading the
// wrong bits, and it is here so the comparison is against the real thing.
const readN = (b, addr, size) => (size === 1 ? b.read8(addr) : size === 2 ? b.read16(addr) : b.read32(addr) >>> 0);
const readFieldOld = (b, base, f) => {
  const raw = readN(b, base + f.offset, f.size);
  return f.bitWidth == null ? raw : (raw >>> f.bitOffset) & ((1 << f.bitWidth) - 1);
};

console.log('=== 1. The reported defect: a struct member at an odd offset ===');
// `struct GfxControlFlags` lives wherever gLevelStatePtr points. Its `u8 bgMapSize[2]`
// sits at offset 3 — two bytes at an ODD address whenever the base is even, which is
// an entirely ordinary thing for a compiler to lay out.
const bgMapSize = di.structMember('GfxControlFlags', 'bgMapSize');
const ptrCell = di.symbolToAddress('gLevelStatePtr');
const structBase = engine.read32(ptrCell);
const memberAddr = structBase + bgMapSize.offset;
console.log(
  `  gLevelStatePtr @0x${ptrCell.toString(16)} -> struct at 0x${structBase.toString(16)}; ` +
    `bgMapSize is ${bgMapSize.size} bytes at +${bgMapSize.offset} -> 0x${memberAddr.toString(16)} (odd)`,
);

engine.writeMember(structBase, bgMapSize, 0x5544); // plant a known value, guarded path
const truth = engine.readBytes(memberAddr, 2);
const viaOldHelper = readFieldOld(bus, structBase, bgMapSize);
const viaNewApi = engine.readMember(structBase, bgMapSize);
console.log(`  bytes actually at that address  : 0x${truth.toString(16).padStart(4, '0')}`);
console.log(`  old readField() over bus.read16 : 0x${viaOldHelper.toString(16).padStart(4, '0')}`);
console.log(`  new engine.readMember()         : 0x${viaNewApi.toString(16).padStart(4, '0')}`);
check('readMember returns the bytes the member names', viaNewApi === truth);
check(
  `the raw-bus path still reads 0x${(structBase + 2).toString(16)} instead — the defect is real, not hypothetical`,
  viaOldHelper !== truth,
);

console.log('\n=== 2. The ill-posed accesses now refuse ===');
const oddMsg = threw(() => engine.read16(memberAddr));
console.log(`  read16(0x${memberAddr.toString(16)}) -> ${oddMsg}`);
check('read16 at an odd address throws', /not 2-byte aligned/.test(oddMsg ?? ''));
check('read32 misaligned throws', /not 4-byte aligned/.test(threw(() => engine.read32(structBase + 1)) ?? ''));
check(
  'read32 of unmapped address space throws',
  /nothing is mapped/.test(threw(() => engine.read32(0x01000000)) ?? ''),
);
check(
  'read32 past the end of this cartridge throws instead of returning 0',
  /nothing is mapped/.test(threw(() => engine.read32(0x08400000)) ?? ''),
);
check(
  'a write into ROM throws instead of being silently dropped',
  /read-only/.test(threw(() => engine.writeMember(0x08000000, { offset: 0, size: 2 }, 1)) ?? ''),
);

console.log('\n=== 3. Positive control: every well-posed read is unchanged ===');
// A guard that rejected ordinary reads would be as useless as one that let the bad
// ones through. Sweep real, aligned, mapped addresses in every backed region and
// compare against the raw hardware bus. The ONE intended difference is that read32 is
// now unsigned, and `>>> 0` is exactly that normalization — so comparing against it
// proves nothing else moved.
const regions = [
  ['ROM', 0x08000000, 0x2000],
  ['EWRAM', 0x02000000, 0x1000],
  ['IWRAM', 0x03000000, 0x1000],
  ['palette', 0x05000000, 0x200],
  ['VRAM', 0x06000000, 0x1000],
  ['OAM', 0x07000000, 0x200],
];
let compared = 0;
let mismatched = 0;
let signFixed = 0;
for (const [, start, len] of regions) {
  for (let off = 0; off < len; off += 2) {
    if (engine.read16(start + off) !== bus.read16(start + off)) {
      mismatched++;
    }
    compared++;
  }
  for (let off = 0; off < len; off += 4) {
    const raw = bus.read32(start + off);
    if (engine.read32(start + off) !== raw >>> 0) {
      mismatched++;
    }
    if (raw < 0) {
      signFixed++;
    }
    compared++;
  }
}
check(
  `${compared} aligned reads across ${regions.length} regions match the raw bus`,
  mismatched === 0,
  `${mismatched} differ`,
);
check(
  `read32 is unsigned on the ${signFixed} words where the bus returns a negative`,
  signFixed > 0,
  'no negatives found, so this control proved nothing',
);

let disagree = 0;
for (let off = 0; off < 0x1000; off += 4) {
  if (engine.readBytes(0x08000000 + off, 4) !== engine.read32(0x08000000 + off)) {
    disagree++;
  }
}
check('readBytes and read32 agree wherever both are well-posed', disagree === 0, `${disagree} differ`);

console.log('\n=== 4. Every bitfield of the struct decodes from its own container ===');
const bitfields = di.struct('GfxControlFlags').members.filter((m) => m.bitWidth !== undefined);
let bfOk = 0;
for (const m of bitfields) {
  const loc = di.structMember('GfxControlFlags', m.name);
  const expected = (engine.readBytes(structBase + loc.offset, loc.size) >>> loc.bitOffset) & (2 ** loc.bitWidth - 1);
  if (engine.readMember(structBase, loc) === expected) {
    bfOk++;
  } else {
    console.log(`    MISMATCH on ${m.name}`);
  }
}
check(`all ${bitfields.length} bitfields decode correctly`, bfOk === bitfields.length);

console.log('\n=== 5. addressToSymbol says whether the ELF placed the address ===');
const funcs = di.symbols.symbols.filter((s) => s.type === 2);
const sized = funcs.filter((s) => s.size > 0).length;
console.log(`  this ELF: ${sized} functions declare an st_size, ${funcs.length - sized} do not`);
const ru = di.symbolToAddress('RenderMenuUI');
const far = di.addressToSymbol(ru + 0xbb8);
console.log(`  RenderMenuUI+0xBB8 -> ${JSON.stringify(far)}`);
check('a hit 3 KB into a size-0 symbol is marked inferred', far.exact === false);
const sizedSym = funcs.find((s) => s.size > 0x20);
const inside = di.addressToSymbol(sizedSym.address + 4);
console.log(`  ${sizedSym.name}+0x4 -> ${JSON.stringify(inside)}`);
check('a hit inside a symbol the ELF sized is marked exact', inside.exact === true);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
