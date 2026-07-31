/**
 * Milestone 2: ScriptingEngine wired to @gba-kit/debug-info.
 *
 * Uses the real minimal agbcc ELF from @gba-kit/debug-info's test projects, so
 * the wiring is exercised against actual symbols + DWARF (no mocks). Oracles
 * match real-projects.spec.ts in the debug-info package.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { Gba } from '../gba.js';
import { ScriptingEngine, type ScriptingHost } from '../scripting.js';

const stubHost: ScriptingHost = {
  writeScreenshot: async () => {},
  writeMemorySnapshot: async () => {},
  writeSaveState: async () => {},
  readSaveState: async () => {
    throw new Error('not used');
  },
  log: () => {},
};

const here = dirname(fileURLToPath(import.meta.url));
// packages/gba-emulator/src/__tests__ -> packages/debug-info/test-projects/...
const AGBCC_ELF = join(here, '..', '..', '..', 'debug-info', 'test-projects', 'agbcc-min', 'build', 'min.elf');
const DEVKITARM_ELF = join(here, '..', '..', '..', 'debug-info', 'test-projects', 'devkitarm-min', 'build', 'min.elf');

function engineWithDebugInfo(): ScriptingEngine {
  const engine = new ScriptingEngine(new Gba(), stubHost);
  engine.loadDebugInfo(new Uint8Array(readFileSync(AGBCC_ELF)));
  return engine;
}

describe('ScriptingEngine debug info', () => {
  it('reports no debug info until loaded', () => {
    const engine = new ScriptingEngine(new Gba(), stubHost);
    expect(engine.hasDebugInfo).toBe(false);
    expect(engine.symbolToAddress('add')).toBeNull();
    expect(engine.pcToSource(0x08000008)).toBeNull();
  });

  it('resolves symbols and PC→source after loadDebugInfo', () => {
    const engine = engineWithDebugInfo();
    expect(engine.hasDebugInfo).toBe(true);
    expect(engine.symbolToAddress('add')).toBe(0x08000008);
    expect(engine.pcToFunction(0x08000008)?.name).toBe('add');
    expect(engine.addressToSymbol(0x0800000a)).toEqual({ name: 'add', offset: 0x2 });

    const src = engine.pcToSource(0x08000008);
    expect(src?.func).toBe('add');
    expect(src?.file.replace(/^.*\//, '')).toBe('main.c');
    expect(src?.line).toBe(94); // add()'s body line in debug-info's agbcc-min/main.c
  });

  it('annotates watch hits with the writer source line', () => {
    const gba = new Gba();
    const engine = new ScriptingEngine(gba, stubHost);
    engine.loadDebugInfo(new Uint8Array(readFileSync(AGBCC_ELF)));

    // Pretend the CPU is mid-Thumb-instruction inside add(): pc-2 = 0x08000008.
    gba.armCpu.registers[15] = 0x0800000a;
    gba.armCpu.cpsr |= 0x20; // Thumb

    const w = engine.watchMemory({ address: 0x03000000 });
    gba.bus.write8(0x03000000, 1);
    w.stop();

    expect(w.hits).toHaveLength(1);
    expect(w.hits[0]!.instructionAddress).toBe(0x08000008);
    expect(w.hits[0]!.location?.func).toBe('add');
    expect(w.hits[0]!.location?.line).toBe(94); // add()'s body line in debug-info's agbcc-min/main.c
  });

  it('watchSymbol resolves a named global and records writes', () => {
    const gba = new Gba();
    const engine = new ScriptingEngine(gba, stubHost);
    engine.loadDebugInfo(new Uint8Array(readFileSync(AGBCC_ELF)));

    const addr = engine.symbolToAddress('g_counter');
    expect(addr).toBe(0x03000000);

    // Defaults the watch length to the symbol's size (g_counter is a 4-byte int),
    // so a write to a high byte of the global is caught — not just byte 0.
    const w = engine.watchSymbol('g_counter');
    gba.bus.write8(0x03000003, 5);
    w.stop();
    expect(w.hits).toHaveLength(1);
    expect(w.hits[0]!.address).toBe(0x03000003);

    // An explicit length still narrows the watch.
    const narrow = engine.watchSymbol('g_counter', { length: 1 });
    gba.bus.write8(0x03000003, 7); // outside the 1-byte watch
    narrow.stop();
    expect(narrow.hits).toHaveLength(0);

    expect(() => engine.watchSymbol('does_not_exist')).toThrow(/unknown symbol/);
  });

  it('readVariable reads a field sized from DWARF, decoding bitfields', () => {
    const gba = new Gba();
    const engine = new ScriptingEngine(gba, stubHost);
    engine.loadDebugInfo(new Uint8Array(readFileSync(AGBCC_ELF)));

    // g_probe.count is a 4-byte int at g_probe+4 — all 4 bytes are read.
    const probe = engine.symbolToAddress('g_probe')!;
    gba.bus.write32(probe + 4, 0x12345678);
    expect(engine.readVariable('g_probe.count')).toBe(0x12345678);

    // g_probe.flags is a 2-byte short at g_probe+8 — only 2 bytes are read.
    gba.bus.write32(probe + 8, 0xffffabcd);
    expect(engine.readVariable('g_probe.flags')).toBe(0xabcd);

    // g_bits.cross is a 7-bit bitfield at bits 5..11 (a 2-byte span), decoded to its value.
    const bits = engine.symbolToAddress('g_bits')!;
    gba.bus.write16(bits, 100 << 5);
    expect(engine.readVariable('g_bits.cross')).toBe(100);

    // A bare scalar global.
    gba.bus.write32(0x03000000, 42);
    expect(engine.readVariable('g_counter')).toBe(42);

    // A 4-byte field with bit 31 set reads back unsigned, not as a negative int32.
    gba.bus.write32(0x03000000, 0x80000001);
    expect(engine.readVariable('g_counter')).toBe(0x80000001);

    expect(() => engine.readVariable('nope')).toThrow(/cannot resolve/);
  });

  it('readVariable refuses values it cannot size', () => {
    const engine = new ScriptingEngine(new Gba(), stubHost);
    engine.loadDebugInfo(new Uint8Array(readFileSync(DEVKITARM_ELF)));

    // g_wide is a `long long` (8 bytes) — it can't be returned as a JS number.
    expect(() => engine.readVariable('g_wide')).toThrow(/wider than 32 bits/);

    // g_blob.data is a flexible array member — its size is unknown, so it can't be read.
    expect(() => engine.readVariable('g_blob.data')).toThrow(/cannot resolve/);
  });

  it('wait({ memory }) accepts a symbol path and validates it before running frames', async () => {
    const engine = new ScriptingEngine(new Gba(), stubHost);
    engine.loadDebugInfo(new Uint8Array(readFileSync(DEVKITARM_ELF)));

    // A path is validated up front (no frames run), so these reject synchronously.
    await expect(engine.wait({ memory: { address: 'nope', equals: 1 }, timeout: 1 })).rejects.toThrow(/cannot resolve/);
    await expect(engine.wait({ memory: { address: 'g_wide', equals: 1 }, timeout: 1 })).rejects.toThrow(
      /wider than 32 bits/,
    );

    // A name can't be resolved without debug info loaded.
    const noInfo = new ScriptingEngine(new Gba(), stubHost);
    await expect(noInfo.wait({ memory: { address: 'g_counter', equals: 1 }, timeout: 1 })).rejects.toThrow(
      /requires debug info/,
    );
  });

  it('assert({ memory }) accepts a symbol path, read at the field width', () => {
    const gba = new Gba();
    const engine = new ScriptingEngine(gba, stubHost);
    engine.loadDebugInfo(new Uint8Array(readFileSync(AGBCC_ELF)));

    gba.bus.write32(0x03000000, 7); // g_counter (a 4-byte int)
    expect(() => engine.assert({ memory: { address: 'g_counter', equals: 7 } })).not.toThrow();
    expect(() => engine.assert({ memory: { address: 'g_counter', equals: 8 } })).toThrow(
      /Assertion failed: memory\["g_counter"/,
    );

    // A raw numeric address still works (single-byte read).
    expect(() => engine.assert({ memory: { address: 0x03000000, equals: 7 } })).not.toThrow();

    // Same validation as wait: unknown path / no debug info fail clearly.
    expect(() => engine.assert({ memory: { address: 'nope', equals: 0 } })).toThrow(/cannot resolve/);
    const noInfo = new ScriptingEngine(new Gba(), stubHost);
    expect(() => noInfo.assert({ memory: { address: 'g_counter', equals: 0 } })).toThrow(/requires debug info/);
  });
});
