import { GbaMemory, LR, SENTINEL_ADDR } from '@gba-kit/arm-emulator';
import { ArmCpu, MODE_SYS } from '@gba-kit/arm-emulator/arm-cpu';
import { describe, expect, it } from 'vitest';

import { handleSwi } from '../bios.js';

// ─── Helpers ────────────────────────────────────────────────────────

const AL = 0xe;

function armBx(rm: number): number {
  return ((AL << 28) | 0x012fff10 | (rm & 0xf)) >>> 0;
}

function armSwi(num: number): number {
  return ((AL << 28) | 0x0f000000 | ((num & 0xff) << 16)) >>> 0;
}

function loadArmInstructions(mem: GbaMemory, baseAddr: number, instructions: number[]): void {
  const buf = new Uint8Array(instructions.length * 4);
  const view = new DataView(buf.buffer);
  instructions.forEach((instr, i) => view.setUint32(i * 4, instr, true));
  mem.loadBytes(baseAddr, buf);
}

function loadThumbInstructions(mem: GbaMemory, baseAddr: number, instructions: number[]): void {
  const buf = new Uint8Array(instructions.length * 2);
  const view = new DataView(buf.buffer);
  instructions.forEach((instr, i) => view.setUint16(i * 2, instr, true));
  mem.loadBytes(baseAddr, buf);
}

function setupArmCpu(instructions: number[], startAddr: number = 0x08000000): { cpu: ArmCpu; mem: GbaMemory } {
  const mem = new GbaMemory();
  const cpu = new ArmCpu(mem, { swiHandler: handleSwi });
  loadArmInstructions(mem, startAddr, instructions);
  cpu.cpsr = MODE_SYS;
  cpu.registers[15] = startAddr;
  cpu.registers[LR] = SENTINEL_ADDR;
  return { cpu, mem };
}

function setupThumbCpu(instructions: number[], startAddr: number = 0x08000000): { cpu: ArmCpu; mem: GbaMemory } {
  const mem = new GbaMemory();
  const cpu = new ArmCpu(mem, { swiHandler: handleSwi });
  loadThumbInstructions(mem, startAddr, instructions);
  cpu.cpsr = MODE_SYS | (1 << 5); // T bit set
  cpu.registers[15] = startAddr;
  cpu.registers[LR] = SENTINEL_ADDR;
  return { cpu, mem };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('GBA BIOS (HLE)', () => {
  it('SWI 0x06: Div', () => {
    const { cpu } = setupArmCpu([armSwi(0x06), armBx(LR)]);
    cpu.registers[0] = 42;
    cpu.registers[1] = 5;
    cpu.run(100);
    expect(cpu.registers[0]! | 0).toBe(8);
    expect(cpu.registers[1]! | 0).toBe(2);
    expect(cpu.registers[3]).toBe(8);
  });

  it('SWI 0x06: Div negative', () => {
    const { cpu } = setupArmCpu([armSwi(0x06), armBx(LR)]);
    cpu.registers[0] = -7 >>> 0;
    cpu.registers[1] = 2;
    cpu.run(100);
    expect(cpu.registers[0]! | 0).toBe(-3);
    expect(cpu.registers[1]! | 0).toBe(-1);
    expect(cpu.registers[3]).toBe(3);
  });

  it('SWI 0x07: DivArm (swapped args)', () => {
    const { cpu } = setupArmCpu([armSwi(0x07), armBx(LR)]);
    cpu.registers[0] = 5;
    cpu.registers[1] = 42;
    cpu.run(100);
    expect(cpu.registers[0]! | 0).toBe(8);
    expect(cpu.registers[1]! | 0).toBe(2);
  });

  it('SWI 0x08: Sqrt', () => {
    const { cpu } = setupArmCpu([armSwi(0x08), armBx(LR)]);
    cpu.registers[0] = 144;
    cpu.run(100);
    expect(cpu.registers[0]).toBe(12);
  });

  it('SWI 0x08: Sqrt non-perfect', () => {
    const { cpu } = setupArmCpu([armSwi(0x08), armBx(LR)]);
    cpu.registers[0] = 10;
    cpu.run(100);
    expect(cpu.registers[0]).toBe(3);
  });

  it('SWI 0x0B: CpuSet (copy, 32-bit)', () => {
    const { cpu, mem } = setupArmCpu([armSwi(0x0b), armBx(LR)]);
    mem.write32(0x02000000, 0x11111111);
    mem.write32(0x02000004, 0x22222222);
    mem.write32(0x02000008, 0x33333333);
    cpu.registers[0] = 0x02000000;
    cpu.registers[1] = 0x02000100;
    cpu.registers[2] = 3 | (1 << 26);
    cpu.run(100);
    expect(mem.read32(0x02000100)).toBe(0x11111111);
    expect(mem.read32(0x02000104)).toBe(0x22222222);
    expect(mem.read32(0x02000108)).toBe(0x33333333);
  });

  it('SWI 0x0B: CpuSet (fill, 32-bit)', () => {
    const { cpu, mem } = setupArmCpu([armSwi(0x0b), armBx(LR)]);
    mem.write32(0x02000000, 0xdeadbeef);
    cpu.registers[0] = 0x02000000;
    cpu.registers[1] = 0x02000100;
    cpu.registers[2] = 4 | (1 << 24) | (1 << 26);
    cpu.run(100);
    expect(mem.read32(0x02000100)).toBe(0xdeadbeef);
    expect(mem.read32(0x02000104)).toBe(0xdeadbeef);
    expect(mem.read32(0x02000108)).toBe(0xdeadbeef);
    expect(mem.read32(0x0200010c)).toBe(0xdeadbeef);
  });

  it('SWI 0x11: LZ77UnCompWram', () => {
    const { cpu, mem } = setupArmCpu([armSwi(0x11), armBx(LR)]);
    const srcAddr = 0x02000000;
    const dstAddr = 0x02000100;
    mem.write32(srcAddr, 0x00000810);
    mem.write8(srcAddr + 4, 0x00);
    mem.write8(srcAddr + 5, 0x41);
    mem.write8(srcAddr + 6, 0x42);
    mem.write8(srcAddr + 7, 0x43);
    mem.write8(srcAddr + 8, 0x44);
    mem.write8(srcAddr + 9, 0x45);
    mem.write8(srcAddr + 10, 0x46);
    mem.write8(srcAddr + 11, 0x47);
    mem.write8(srcAddr + 12, 0x48);
    cpu.registers[0] = srcAddr;
    cpu.registers[1] = dstAddr;
    cpu.run(100);
    expect(mem.read8(dstAddr)).toBe(0x41);
    expect(mem.read8(dstAddr + 1)).toBe(0x42);
    expect(mem.read8(dstAddr + 7)).toBe(0x48);
  });

  it('SWI 0x11: LZ77 with back-reference', () => {
    const { cpu, mem } = setupArmCpu([armSwi(0x11), armBx(LR)]);
    const srcAddr = 0x02000000;
    const dstAddr = 0x02000100;
    mem.write32(srcAddr, 0x00000710);
    mem.write8(srcAddr + 4, 0x08);
    mem.write8(srcAddr + 5, 0xaa);
    mem.write8(srcAddr + 6, 0xbb);
    mem.write8(srcAddr + 7, 0xcc);
    mem.write8(srcAddr + 8, 0xdd);
    mem.write8(srcAddr + 9, 0x00);
    mem.write8(srcAddr + 10, 0x03);
    cpu.registers[0] = srcAddr;
    cpu.registers[1] = dstAddr;
    cpu.run(100);
    expect(mem.read8(dstAddr)).toBe(0xaa);
    expect(mem.read8(dstAddr + 1)).toBe(0xbb);
    expect(mem.read8(dstAddr + 2)).toBe(0xcc);
    expect(mem.read8(dstAddr + 3)).toBe(0xdd);
    expect(mem.read8(dstAddr + 4)).toBe(0xaa);
    expect(mem.read8(dstAddr + 5)).toBe(0xbb);
    expect(mem.read8(dstAddr + 6)).toBe(0xcc);
  });

  it('SWI 0x06: Div via Thumb SWI', () => {
    const { cpu } = setupThumbCpu([
      0xdf06, // swi #6
      0x4770, // bx lr
    ]);
    cpu.registers[0] = 100;
    cpu.registers[1] = 7;
    cpu.run(100);
    expect(cpu.registers[0]! | 0).toBe(14);
    expect(cpu.registers[1]! | 0).toBe(2);
  });
});
