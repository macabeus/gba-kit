/**
 * What `step()` reports an instruction costs: its data accesses, its internal cycles, a branch's
 * refill and the opcode fetch that ends it, each priced by the bus (GBATEK "ARM CPU Instruction
 * Cycle Times"; NanoBoyAdvance src/nba/src/arm/handlers).
 */
import { describe, expect, it } from 'vitest';

import { ArmCpu, MODE_SYS } from '../arm-cpu.js';
import { GbaMemory } from '../memory.js';
import { LR, PC, SENTINEL_ADDR, SP } from '../types.js';

const ROM = 0x08000000;
const IWRAM = 0x03000000;
const EWRAM = 0x02000000;

function bytesOf(words: number[], width: 2 | 4): Uint8Array {
  const bytes = new Uint8Array(words.length * width);
  words.forEach((w, i) => {
    for (let b = 0; b < width; b++) {
      bytes[i * width + b] = (w >>> (8 * b)) & 0xff;
    }
  });
  return bytes;
}

function cpuWith(mem: GbaMemory, words: number[], thumb: boolean, at = ROM): ArmCpu {
  const cpu = new ArmCpu(mem, { swiHandler: () => 40 });
  mem.loadBytes(at, bytesOf(words, thumb ? 2 : 4));
  cpu.cpsr = MODE_SYS | (thumb ? 1 << 5 : 0);
  cpu.registers[PC] = at;
  cpu.registers[LR] = SENTINEL_ADDR;
  cpu.registers[SP] = 0x03007f00;
  return cpu;
}

/** A bus with wait states: each region charges its own N and S price; it prefetches nothing. */
class PricedMemory extends GbaMemory {
  constructor(readonly prices: Record<number, { n: number; s: number }>) {
    super();
  }

  override accessCycles(address: number, _width: 1 | 2 | 4, sequential: boolean): number {
    const price = this.prices[address >>> 24] ?? { n: 1, s: 1 };
    return sequential ? price.s : price.n;
  }

  override fetchCycles(address: number, width: 2 | 4, sequential: boolean): number {
    return this.accessCycles(address, width, sequential);
  }

  override dataCycles(address: number, width: 1 | 2 | 4, sequential: boolean): number {
    return this.accessCycles(address, width, sequential);
  }
}

/** A zero-wait bus that records the accesses and internal cycles the CPU reports, in order. */
class RecordingMemory extends GbaMemory {
  readonly calls: string[] = [];

  override fetchCycles(address: number, _width: 2 | 4, sequential: boolean): number {
    this.calls.push(`fetch ${sequential ? 'S' : 'N'} ${address.toString(16)}`);
    return 1;
  }

  override dataCycles(address: number, _width: 1 | 2 | 4, sequential: boolean): number {
    this.calls.push(`data ${sequential ? 'S' : 'N'} ${address.toString(16)}`);
    return 1;
  }

  override idle(cycles: number): void {
    this.calls.push(`idle ${cycles}`);
  }
}

describe('ArmCpu cycle counts on a zero-wait bus', () => {
  // Every access is 1 cycle, so these are the S/N/I counts of GBATEK's table.
  const arm: Array<[string, number[], number, (cpu: ArmCpu) => void]> = [
    ['add r0, r0, #1 (1S)', [0xe2800001], 1, () => {}],
    ['add r0, r0, r1, lsl r2 (1S+1I)', [0xe0800211], 2, () => {}],
    ['ldr r0, [r1] (1S+1N+1I)', [0xe5910000], 3, (cpu) => (cpu.registers[1] = IWRAM)],
    ['str r0, [r1] (2N)', [0xe5810000], 2, (cpu) => (cpu.registers[1] = IWRAM)],
    ['b (2S+1N)', [0xea000000], 3, () => {}],
    ['mul r0, r1, r2, multiplier 3 (1S+1I)', [0xe0000291], 2, (cpu) => (cpu.registers[2] = 3)],
    ['mla r0, r1, r2, r3, multiplier 3 (1S+2I)', [0xe0203291], 3, (cpu) => (cpu.registers[2] = 3)],
    ['umull r0, r1, r2, r3, multiplier -1 (1S+5I)', [0xe0810392], 6, (cpu) => (cpu.registers[3] = 0xffffffff)],
    ['smlal r0, r1, r2, r3, multiplier -1 (1S+3I)', [0xe0e10392], 4, (cpu) => (cpu.registers[3] = 0xffffffff)],
    ['ldmia r1, {r2-r5} (4S+1N+1I)', [0xe891003c], 6, (cpu) => (cpu.registers[1] = IWRAM)],
    ['stmia r1, {r2-r5} (3S+2N)', [0xe881003c], 5, (cpu) => (cpu.registers[1] = IWRAM)],
    ['swp r0, r2, [r1] (1S+2N+1I)', [0xe1010092], 4, (cpu) => (cpu.registers[1] = IWRAM)],
    ['ldmia r1, {r2, pc} (3S+2N+1I)', [0xe8918004], 6, (cpu) => (cpu.registers[1] = IWRAM)],
    ['mov pc, r1 (2S+1N)', [0xe1a0f001], 3, (cpu) => (cpu.registers[1] = ROM + 0x100)],
    ['swi 6: the fetch, the handler`s 40 cycles and the return refill', [0xef060000], 43, () => {}],
    ['addne r0, r0, #1 with Z set: the fetch alone', [0x12800001], 1, (cpu) => (cpu.cpsr |= 1 << 30)],
  ];
  for (const [name, words, cycles, setup] of arm) {
    it(`ARM ${name}: ${cycles}`, () => {
      const cpu = cpuWith(new GbaMemory(), words, false);
      setup(cpu);
      expect(cpu.step()).toBe(cycles);
    });
  }

  const thumb: Array<[string, number[], number, (cpu: ArmCpu) => void]> = [
    ['lsls r0, r1 (1S+1I)', [0x4088], 2, () => {}],
    ['muls r0, r1, multiplier 3 (1S+1I)', [0x4348], 2, (cpu) => (cpu.registers[0] = 3)],
    ['ldr r0, [r1, #0] (1S+1N+1I)', [0x6808], 3, (cpu) => (cpu.registers[1] = IWRAM)],
    ['push {r4, r5, lr} (2S+2N)', [0xb530], 4, () => {}],
    ['b (2S+1N)', [0xe000], 3, () => {}],
  ];
  for (const [name, words, cycles, setup] of thumb) {
    it(`Thumb ${name}: ${cycles}`, () => {
      const cpu = cpuWith(new GbaMemory(), words, true);
      setup(cpu);
      expect(cpu.step()).toBe(cycles);
    });
  }
});

describe('ArmCpu cycle counts on a bus with wait states', () => {
  const slowRom = { 0x08: { n: 5, s: 3 }, 0x02: { n: 3, s: 2 } };

  it('every instruction pays an S fetch from the memory it runs in', () => {
    const cpu = cpuWith(new PricedMemory(slowRom), [0xe2800001 /* add r0, r0, #1 */], false);
    expect(cpu.step()).toBe(3);
  });

  it('a branch pays an N fetch of the target and an S fetch after it', () => {
    const cpu = cpuWith(new PricedMemory(slowRom), [0xea000000 /* b .+8 */], false);
    expect(cpu.step()).toBe(3 + 5 + 3);
  });

  it('after a data access the next fetch is nonsequential', () => {
    // ldr r0, [r1] from ROM reading IWRAM: S fetch, N load, I cycle, and N - S for the next fetch.
    const cpu = cpuWith(new PricedMemory(slowRom), [0xe5910000], false);
    cpu.registers[1] = IWRAM;
    expect(cpu.step()).toBe(3 + 1 + 1 + (5 - 3));
  });

  it('a swap is an N load, an N store and an I cycle, and the fetch after it is nonsequential', () => {
    // swp r0, r2, [r1] from ROM on IWRAM: GBATEK SWP 1S+2N+1I; the next fetch costs N - S more.
    const cpu = cpuWith(new PricedMemory(slowRom), [0xe1010092], false);
    cpu.registers[1] = IWRAM;
    expect(cpu.step()).toBe(3 + 1 + 1 + 1 + (5 - 3));
  });

  it('a block transfer is one N access and then S accesses', () => {
    // ldmia r1, {r2-r5} from IWRAM reading EWRAM: 1 + (3 + 2 + 2 + 2) + 1.
    const cpu = cpuWith(new PricedMemory(slowRom), [0xe891003c], false, IWRAM);
    cpu.registers[1] = EWRAM;
    expect(cpu.step()).toBe(1 + 3 + 3 * 2 + 1);
  });

  it('a load into the PC refills from the target, and the refill replaces the nonsequential fetch', () => {
    // ldr pc, [r1] from ROM: N load, I cycle, N+S refill, S fetch: GBATEK LDR PC 2S+2N+1I.
    const mem = new PricedMemory(slowRom);
    mem.write32(IWRAM, ROM + 0x100);
    const cpu = cpuWith(mem, [0xe591f000], false);
    cpu.registers[1] = IWRAM;
    expect(cpu.step()).toBe(1 + 1 + 5 + 3 + 3);
    expect(cpu.registers[PC]).toBe(ROM + 0x100);
  });

  it('a shift by a register spends an I cycle, after which the fetch is nonsequential', () => {
    // add r0, r0, r1, lsl r2 from ROM: like a multiply, an internal cycle then an N fetch.
    const cpu = cpuWith(new PricedMemory(slowRom), [0xe0800211], false);
    expect(cpu.step()).toBe(1 + 5);
    const thumb = cpuWith(new PricedMemory(slowRom), [0x4088 /* lsls r0, r1 */], true);
    expect(thumb.step()).toBe(1 + 5);
  });

  it('reports every access and internal cycle to the bus in the order they happen', () => {
    // NanoBoyAdvance's ARM_SingleDataTransfer: the load, the I cycle, then the next fetch.
    const ldr = new RecordingMemory();
    const cpu = cpuWith(ldr, [0xe5910000 /* ldr r0, [r1] */], false);
    cpu.registers[1] = IWRAM;
    cpu.step();
    expect(ldr.calls).toEqual(['data N 3000000', 'idle 1', 'fetch N 800000c']);

    // A branch refills N then S, and the fetch after it continues the new stream.
    const b = new RecordingMemory();
    cpuWith(b, [0xea000000 /* b .+8 */], false).step();
    expect(b.calls).toEqual(['fetch N 8000008', 'fetch S 800000c', 'fetch S 8000010']);

    // A block transfer: N, then S for each further word, then the I cycle of a load.
    const ldm = new RecordingMemory();
    const block = cpuWith(ldm, [0xe891000c /* ldmia r1, {r2, r3} */], false);
    block.registers[1] = IWRAM;
    block.step();
    expect(ldm.calls).toEqual(['data N 3000000', 'data S 3000004', 'idle 1', 'fetch N 800000c']);
  });

  it('a PC written from outside refills the pipeline at no cost; a refused instruction costs nothing', () => {
    const cpu = cpuWith(new PricedMemory(slowRom), [0xe2800001], false);
    cpu.setDebugHooks({ onInstructionPre: () => 'break' });
    expect(cpu.step()).toBe(0);
    expect(cpu.refused).toBe(true);
    cpu.setDebugHooks(undefined);
    expect(cpu.step()).toBe(3);
    expect(cpu.refused).toBe(false);
  });

  it('entering an interrupt costs the refill at the vector', () => {
    const cpu = cpuWith(new PricedMemory({ 0x00: { n: 2, s: 1 } }), [0xe2800001], false);
    expect(cpu.enterIrq()).toBe(2 + 1);
  });
});
