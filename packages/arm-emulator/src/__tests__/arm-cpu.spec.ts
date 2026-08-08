import { describe, expect, it } from 'vitest';

import { ArmCpu, MODE_FIQ, MODE_IRQ, MODE_SVC, MODE_SYS } from '../arm-cpu.js';
import { GbaMemory } from '../memory.js';
import { LR, PC, SENTINEL_ADDR, SP } from '../types.js';

// ─── Helpers ────────────────────────────────────────────────────────

/** Load 32-bit ARM instructions into memory at the given address */
function loadArmInstructions(mem: GbaMemory, baseAddr: number, instructions: number[]): void {
  const bytes = new Uint8Array(instructions.length * 4);
  for (let i = 0; i < instructions.length; i++) {
    const instr = instructions[i]!;
    bytes[i * 4] = instr & 0xff;
    bytes[i * 4 + 1] = (instr >>> 8) & 0xff;
    bytes[i * 4 + 2] = (instr >>> 16) & 0xff;
    bytes[i * 4 + 3] = (instr >>> 24) & 0xff;
  }
  mem.loadBytes(baseAddr, bytes);
}

/** Load 16-bit Thumb instructions into memory at the given address */
function loadThumbInstructions(mem: GbaMemory, baseAddr: number, instructions: number[]): void {
  const bytes = new Uint8Array(instructions.length * 2);
  for (let i = 0; i < instructions.length; i++) {
    bytes[i * 2] = instructions[i]! & 0xff;
    bytes[i * 2 + 1] = (instructions[i]! >>> 8) & 0xff;
  }
  mem.loadBytes(baseAddr, bytes);
}

/** Create an ArmCpu in ARM mode with instructions loaded */
function setupArmCpu(instructions: number[], startAddr: number = 0x08000000): { cpu: ArmCpu; mem: GbaMemory } {
  const mem = new GbaMemory();
  const cpu = new ArmCpu(mem);
  loadArmInstructions(mem, startAddr, instructions);
  // ARM mode: T bit clear (default CPSR has T=0)
  cpu.cpsr = MODE_SYS; // ARM mode, no IRQ/FIQ disable for tests
  cpu.registers[PC] = startAddr;
  cpu.registers[LR] = SENTINEL_ADDR;
  cpu.registers[SP] = 0x03007f00;
  return { cpu, mem };
}

/** Create an ArmCpu in Thumb mode with instructions loaded */
function setupThumbCpu(instructions: number[], startAddr: number = 0x08000000): { cpu: ArmCpu; mem: GbaMemory } {
  const mem = new GbaMemory();
  const cpu = new ArmCpu(mem);
  loadThumbInstructions(mem, startAddr, instructions);
  // Set Thumb mode
  cpu.cpsr = MODE_SYS | (1 << 5); // T bit set
  cpu.registers[PC] = startAddr;
  cpu.registers[LR] = SENTINEL_ADDR | 1;
  cpu.registers[SP] = 0x03007f00;
  return { cpu, mem };
}

// ─── ARM Instruction Encoding Helpers ───────────────────────────────

/** Encode an ARM data processing instruction */
function armDP(
  cond: number,
  opcode: number,
  s: number,
  rn: number,
  rd: number,
  op2: number,
  immediate: boolean = false,
): number {
  return (
    ((cond & 0xf) << 28) |
    ((immediate ? 1 : 0) << 25) |
    ((opcode & 0xf) << 21) |
    ((s & 1) << 20) |
    ((rn & 0xf) << 16) |
    ((rd & 0xf) << 12) |
    (op2 & 0xfff)
  );
}

/** Always condition */
const AL = 0xe;

/** Encode MOV Rd, #imm (ARM) */
function armMovImm(rd: number, imm: number): number {
  return armDP(AL, 0xd, 0, 0, rd, imm & 0xff, true);
}

/** Encode MOVS Rd, #imm (ARM) */
function armMovsImm(rd: number, imm: number): number {
  return armDP(AL, 0xd, 1, 0, rd, imm & 0xff, true);
}

/** Encode MOV Rd, Rm (ARM) */
function armMovReg(rd: number, rm: number): number {
  return armDP(AL, 0xd, 0, 0, rd, rm & 0xf, false);
}

/** Encode ADD Rd, Rn, #imm (ARM) */
function armAddImm(rd: number, rn: number, imm: number): number {
  return armDP(AL, 0x4, 0, rn, rd, imm & 0xff, true);
}

/** Encode ADDS Rd, Rn, #imm (ARM) */
function armAddsImm(rd: number, rn: number, imm: number): number {
  return armDP(AL, 0x4, 1, rn, rd, imm & 0xff, true);
}

/** Encode SUB Rd, Rn, #imm (ARM) */
function armSubImm(rd: number, rn: number, imm: number): number {
  return armDP(AL, 0x2, 0, rn, rd, imm & 0xff, true);
}

/** Encode SUBS Rd, Rn, #imm (ARM) */
function armSubsImm(rd: number, rn: number, imm: number): number {
  return armDP(AL, 0x2, 1, rn, rd, imm & 0xff, true);
}

/** Encode ADD Rd, Rn, Rm (ARM) */
function armAddReg(rd: number, rn: number, rm: number): number {
  return armDP(AL, 0x4, 0, rn, rd, rm & 0xf, false);
}

/** Encode ADDS Rd, Rn, Rm (ARM) */
function armAddsReg(rd: number, rn: number, rm: number): number {
  return armDP(AL, 0x4, 1, rn, rd, rm & 0xf, false);
}

/** Encode SUB Rd, Rn, Rm (ARM) */
function armSubReg(rd: number, rn: number, rm: number): number {
  return armDP(AL, 0x2, 0, rn, rd, rm & 0xf, false);
}

/** Encode CMP Rn, #imm (ARM) */
function armCmpImm(rn: number, imm: number): number {
  return armDP(AL, 0xa, 1, rn, 0, imm & 0xff, true);
}

/** Encode CMP Rn, Rm (ARM) */
function armCmpReg(rn: number, rm: number): number {
  return armDP(AL, 0xa, 1, rn, 0, rm & 0xf, false);
}

/** Encode AND Rd, Rn, #imm */
function armAndImm(rd: number, rn: number, imm: number): number {
  return armDP(AL, 0x0, 0, rn, rd, imm & 0xff, true);
}

/** Encode ORR Rd, Rn, #imm */
function armOrrImm(rd: number, rn: number, imm: number): number {
  return armDP(AL, 0xc, 0, rn, rd, imm & 0xff, true);
}

/** Encode EOR Rd, Rn, #imm */
function armEorImm(rd: number, rn: number, imm: number): number {
  return armDP(AL, 0x1, 0, rn, rd, imm & 0xff, true);
}

/** Encode BIC Rd, Rn, #imm */
function armBicImm(rd: number, rn: number, imm: number): number {
  return armDP(AL, 0xe, 0, rn, rd, imm & 0xff, true);
}

/** Encode MVN Rd, #imm */
function armMvnImm(rd: number, imm: number): number {
  return armDP(AL, 0xf, 0, 0, rd, imm & 0xff, true);
}

/** Encode TST Rn, #imm */
function armTstImm(rn: number, imm: number): number {
  return armDP(AL, 0x8, 1, rn, 0, imm & 0xff, true);
}

/** Encode RSB Rd, Rn, #imm */
function armRsbImm(rd: number, rn: number, imm: number): number {
  return armDP(AL, 0x3, 0, rn, rd, imm & 0xff, true);
}

/** Encode ARM BX Rm */
function armBx(rm: number): number {
  return 0xe12fff10 | (rm & 0xf);
}

/** Encode ARM B (branch, offset in words relative to PC+8) */
function armB(offsetWords: number): number {
  return 0xea000000 | (offsetWords & 0x00ffffff);
}

/** Encode ARM BL (branch with link, offset in words relative to PC+8) */
function armBl(offsetWords: number): number {
  return 0xeb000000 | (offsetWords & 0x00ffffff);
}

/** Encode ARM LDR Rd, [Rn, #offset] (pre-indexed, no writeback) */
function armLdrImm(rd: number, rn: number, offset: number, up: boolean = true): number {
  const u = up ? 1 : 0;
  const absOffset = Math.abs(offset);
  return (AL << 28) | (0x01 << 26) | (1 << 24) | (u << 23) | (1 << 20) | (rn << 16) | (rd << 12) | (absOffset & 0xfff);
}

/** Encode ARM STR Rd, [Rn, #offset] (pre-indexed, no writeback) */
function armStrImm(rd: number, rn: number, offset: number, up: boolean = true): number {
  const u = up ? 1 : 0;
  const absOffset = Math.abs(offset);
  return (AL << 28) | (0x01 << 26) | (1 << 24) | (u << 23) | (rn << 16) | (rd << 12) | (absOffset & 0xfff);
}

/** Encode ARM LDRB Rd, [Rn, #offset] */
function armLdrbImm(rd: number, rn: number, offset: number): number {
  return (
    (AL << 28) |
    (0x01 << 26) |
    (1 << 24) |
    (1 << 23) |
    (1 << 22) |
    (1 << 20) |
    (rn << 16) |
    (rd << 12) |
    (offset & 0xfff)
  );
}

/** Encode ARM STRB Rd, [Rn, #offset] */
function armStrbImm(rd: number, rn: number, offset: number): number {
  return (AL << 28) | (0x01 << 26) | (1 << 24) | (1 << 23) | (1 << 22) | (rn << 16) | (rd << 12) | (offset & 0xfff);
}

/** Encode ARM LDRH Rd, [Rn, #offset] (immediate offset halfword load) */
function armLdrhImm(rd: number, rn: number, offset: number): number {
  const hiNibble = (offset >>> 4) & 0xf;
  const loNibble = offset & 0xf;
  return (
    (AL << 28) |
    (1 << 24) |
    (1 << 23) |
    (1 << 22) |
    (1 << 20) |
    (rn << 16) |
    (rd << 12) |
    (hiNibble << 8) |
    0xb0 |
    loNibble
  );
}

/** Encode ARM STRH Rd, [Rn, #offset] (immediate offset halfword store) */
function armStrhImm(rd: number, rn: number, offset: number): number {
  const hiNibble = (offset >>> 4) & 0xf;
  const loNibble = offset & 0xf;
  return (AL << 28) | (1 << 24) | (1 << 23) | (1 << 22) | (rn << 16) | (rd << 12) | (hiNibble << 8) | 0xb0 | loNibble;
}

/** Encode ARM MUL Rd, Rm, Rs */
function armMul(rd: number, rm: number, rs: number, s: number = 0): number {
  return (AL << 28) | (s << 20) | (rd << 16) | (rs << 8) | 0x90 | rm;
}

/** Encode ARM MLA Rd, Rm, Rs, Rn */
function armMla(rd: number, rm: number, rs: number, rn: number, s: number = 0): number {
  return (AL << 28) | (1 << 21) | (s << 20) | (rd << 16) | (rn << 12) | (rs << 8) | 0x90 | rm;
}

/** Encode ARM STMIA/STMDB/LDMIA/LDMDB */
function armBlockTransfer(
  load: boolean,
  pre: boolean,
  up: boolean,
  writeback: boolean,
  rn: number,
  rlist: number,
): number {
  return (
    (AL << 28) |
    (0x4 << 25) |
    ((pre ? 1 : 0) << 24) |
    ((up ? 1 : 0) << 23) |
    ((writeback ? 1 : 0) << 21) |
    ((load ? 1 : 0) << 20) |
    (rn << 16) |
    (rlist & 0xffff)
  );
}

/** Encode ARM data processing with Rm, shift type, and immediate shift amount */
function armDpShiftImm(
  opcode: number,
  s: number,
  rd: number,
  rn: number,
  rm: number,
  shiftType: number,
  shiftAmount: number,
): number {
  return (
    (AL << 28) |
    ((opcode & 0xf) << 21) |
    ((s & 1) << 20) |
    ((rn & 0xf) << 16) |
    ((rd & 0xf) << 12) |
    ((shiftAmount & 0x1f) << 7) |
    ((shiftType & 3) << 5) |
    (rm & 0xf)
  );
}

/** Encode a conditional data processing instruction */
function armCondDP(
  cond: number,
  opcode: number,
  s: number,
  rn: number,
  rd: number,
  op2: number,
  immediate: boolean = false,
): number {
  return (
    ((cond & 0xf) << 28) |
    ((immediate ? 1 : 0) << 25) |
    ((opcode & 0xf) << 21) |
    ((s & 1) << 20) |
    ((rn & 0xf) << 16) |
    ((rd & 0xf) << 12) |
    (op2 & 0xfff)
  );
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('ArmCpu', () => {
  describe('halt and sentinel', () => {
    it('halts when PC reaches sentinel via BX LR', () => {
      const { cpu } = setupArmCpu([armBx(LR)]);
      const result = cpu.run(100);
      expect(result.completed).toBe(true);
    });

    it('respects instruction limit', () => {
      // B . (branch to self: offset = -2 words relative to PC+8 = current instruction)
      const { cpu } = setupArmCpu([armB(0x00fffffe)]);
      const result = cpu.run(10);
      expect(result.completed).toBe(false);
      expect(result.instructionsExecuted).toBe(10);
    });
  });

  describe('ARM data processing: MOV', () => {
    it('MOV Rd, #imm', () => {
      const { cpu } = setupArmCpu([
        armMovImm(0, 42), // mov r0, #42
        armBx(LR),
      ]);
      cpu.run(100);
      expect(cpu.registers[0]).toBe(42);
    });

    it('MOV Rd, Rm', () => {
      const { cpu } = setupArmCpu([
        armMovReg(0, 1), // mov r0, r1
        armBx(LR),
      ]);
      cpu.registers[1] = 0xdeadbeef;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0xdeadbeef);
    });

    it('MOVS sets Z flag for zero', () => {
      const { cpu } = setupArmCpu([
        armMovsImm(0, 0), // movs r0, #0
        armBx(LR),
      ]);
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0);
      expect(cpu.getZ()).toBe(true);
      expect(cpu.getN()).toBe(false);
    });

    it('MVN Rd, #imm', () => {
      const { cpu } = setupArmCpu([
        armMvnImm(0, 0), // mvn r0, #0 => 0xFFFFFFFF
        armBx(LR),
      ]);
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0xffffffff);
    });
  });

  describe('ARM data processing: ADD/SUB', () => {
    it('ADD Rd, Rn, #imm', () => {
      const { cpu } = setupArmCpu([
        armAddImm(0, 1, 10), // add r0, r1, #10
        armBx(LR),
      ]);
      cpu.registers[1] = 100;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(110);
    });

    it('ADDS sets carry flag', () => {
      const { cpu } = setupArmCpu([
        armAddsImm(0, 1, 1), // adds r0, r1, #1
        armBx(LR),
      ]);
      cpu.registers[1] = 0xffffffff;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0);
      expect(cpu.getC()).toBe(true);
      expect(cpu.getZ()).toBe(true);
    });

    it('SUB Rd, Rn, #imm', () => {
      const { cpu } = setupArmCpu([
        armSubImm(0, 1, 10), // sub r0, r1, #10
        armBx(LR),
      ]);
      cpu.registers[1] = 100;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(90);
    });

    it('SUBS sets negative flag', () => {
      const { cpu } = setupArmCpu([
        armSubsImm(0, 1, 1), // subs r0, r1, #1
        armBx(LR),
      ]);
      cpu.registers[1] = 0;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0xffffffff);
      expect(cpu.getN()).toBe(true);
    });

    it('ADD Rd, Rn, Rm', () => {
      const { cpu } = setupArmCpu([
        armAddReg(0, 1, 2), // add r0, r1, r2
        armBx(LR),
      ]);
      cpu.registers[1] = 30;
      cpu.registers[2] = 12;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(42);
    });

    it('SUB Rd, Rn, Rm', () => {
      const { cpu } = setupArmCpu([
        armSubReg(0, 1, 2), // sub r0, r1, r2
        armBx(LR),
      ]);
      cpu.registers[1] = 50;
      cpu.registers[2] = 8;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(42);
    });

    it('ADDS Rd, Rn, Rm sets Z flag on zero result', () => {
      const { cpu } = setupArmCpu([
        armAddsReg(0, 1, 2), // adds r0, r1, r2
        armBx(LR),
      ]);
      cpu.registers[1] = 0;
      cpu.registers[2] = 0;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0);
      expect(cpu.getZ()).toBe(true);
    });

    it('ADDS Rd, Rn, Rm sets C flag on overflow', () => {
      const { cpu } = setupArmCpu([
        armAddsReg(0, 1, 2), // adds r0, r1, r2
        armBx(LR),
      ]);
      cpu.registers[1] = 0xffffffff;
      cpu.registers[2] = 1;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0);
      expect(cpu.getC()).toBe(true);
      expect(cpu.getZ()).toBe(true);
    });

    it('ADDS Rd, Rn, Rm sets N flag on negative result', () => {
      const { cpu } = setupArmCpu([
        armAddsReg(0, 1, 2), // adds r0, r1, r2
        armBx(LR),
      ]);
      cpu.registers[1] = 0xfffffff0;
      cpu.registers[2] = 5;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0xfffffff5);
      expect(cpu.getN()).toBe(true);
    });

    it('RSB Rd, Rn, #imm (reverse subtract)', () => {
      const { cpu } = setupArmCpu([
        armRsbImm(0, 1, 100), // rsb r0, r1, #100
        armBx(LR),
      ]);
      cpu.registers[1] = 30;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(70);
    });
  });

  describe('ARM data processing: CMP/TST', () => {
    it('CMP sets Z flag when equal', () => {
      const { cpu } = setupArmCpu([
        armCmpImm(0, 42), // cmp r0, #42
        armBx(LR),
      ]);
      cpu.registers[0] = 42;
      cpu.run(100);
      expect(cpu.getZ()).toBe(true);
    });

    it('CMP sets N flag when less', () => {
      const { cpu } = setupArmCpu([
        armCmpImm(0, 100), // cmp r0, #100
        armBx(LR),
      ]);
      cpu.registers[0] = 50;
      cpu.run(100);
      expect(cpu.getN()).toBe(true);
    });

    it('CMP Rn, Rm sets Z flag when registers are equal', () => {
      const { cpu } = setupArmCpu([
        armCmpReg(0, 1), // cmp r0, r1
        armBx(LR),
      ]);
      cpu.registers[0] = 42;
      cpu.registers[1] = 42;
      cpu.run(100);
      expect(cpu.getZ()).toBe(true);
    });

    it('CMP Rn, Rm sets N flag when Rn < Rm', () => {
      const { cpu } = setupArmCpu([
        armCmpReg(0, 1), // cmp r0, r1
        armBx(LR),
      ]);
      cpu.registers[0] = 10;
      cpu.registers[1] = 50;
      cpu.run(100);
      expect(cpu.getN()).toBe(true);
      expect(cpu.getZ()).toBe(false);
    });

    it('CMP Rn, Rm sets C flag when Rn >= Rm', () => {
      const { cpu } = setupArmCpu([
        armCmpReg(0, 1), // cmp r0, r1
        armBx(LR),
      ]);
      cpu.registers[0] = 100;
      cpu.registers[1] = 50;
      cpu.run(100);
      expect(cpu.getC()).toBe(true);
      expect(cpu.getN()).toBe(false);
    });

    it('TST sets Z when AND is zero', () => {
      const { cpu } = setupArmCpu([
        armTstImm(0, 0x0f), // tst r0, #0x0f
        armBx(LR),
      ]);
      cpu.registers[0] = 0xf0;
      cpu.run(100);
      expect(cpu.getZ()).toBe(true);
    });

    it('TST clears Z when AND is non-zero', () => {
      const { cpu } = setupArmCpu([
        armTstImm(0, 0x0f), // tst r0, #0x0f
        armBx(LR),
      ]);
      cpu.registers[0] = 0xff;
      cpu.run(100);
      expect(cpu.getZ()).toBe(false);
    });
  });

  describe('ARM data processing: logical', () => {
    it('AND Rd, Rn, #imm', () => {
      const { cpu } = setupArmCpu([armAndImm(0, 1, 0x0f), armBx(LR)]);
      cpu.registers[1] = 0xff;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0x0f);
    });

    it('ORR Rd, Rn, #imm', () => {
      const { cpu } = setupArmCpu([armOrrImm(0, 1, 0x0f), armBx(LR)]);
      cpu.registers[1] = 0xf0;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0xff);
    });

    it('EOR Rd, Rn, #imm', () => {
      const { cpu } = setupArmCpu([armEorImm(0, 1, 0xff), armBx(LR)]);
      cpu.registers[1] = 0xf0;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0x0f);
    });

    it('BIC Rd, Rn, #imm', () => {
      const { cpu } = setupArmCpu([armBicImm(0, 1, 0x0f), armBx(LR)]);
      cpu.registers[1] = 0xff;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0xf0);
    });
  });

  describe('ARM barrel shifter', () => {
    it('immediate rotation: MOV Rd, #imm ROR #n', () => {
      // MOV r0, #0xFF, ROR #8 => #0xFF000000
      // Encoding: immediate with rotate=4 (4*2=8), imm8=0xFF
      const instr = (AL << 28) | (1 << 25) | (0xd << 21) | (0 << 12) | (4 << 8) | 0xff;
      const { cpu } = setupArmCpu([instr, armBx(LR)]);
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0xff000000);
    });

    it('MOV Rd, Rm LSL #n', () => {
      // mov r0, r1, lsl #4
      const instr = armDpShiftImm(0xd, 0, 0, 0, 1, 0, 4);
      const { cpu } = setupArmCpu([instr, armBx(LR)]);
      cpu.registers[1] = 0x0f;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0xf0);
    });

    it('MOV Rd, Rm LSR #n', () => {
      const instr = armDpShiftImm(0xd, 0, 0, 0, 1, 1, 4);
      const { cpu } = setupArmCpu([instr, armBx(LR)]);
      cpu.registers[1] = 0xf0;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0x0f);
    });

    it('MOV Rd, Rm ASR #n', () => {
      const instr = armDpShiftImm(0xd, 0, 0, 0, 1, 2, 4);
      const { cpu } = setupArmCpu([instr, armBx(LR)]);
      cpu.registers[1] = 0xffffff00;
      cpu.run(100);
      expect(cpu.registers[0]! | 0).toBe(0xffffff00 >> 4);
    });

    it('MOV Rd, Rm ROR #n', () => {
      const instr = armDpShiftImm(0xd, 0, 0, 0, 1, 3, 8);
      const { cpu } = setupArmCpu([instr, armBx(LR)]);
      cpu.registers[1] = 0x000000ff;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0xff000000);
    });

    it('ADD Rd, Rn, Rm LSL #n', () => {
      // add r0, r1, r2, lsl #2
      const instr = armDpShiftImm(0x4, 0, 0, 1, 2, 0, 2);
      const { cpu } = setupArmCpu([instr, armBx(LR)]);
      cpu.registers[1] = 10;
      cpu.registers[2] = 3;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(22); // 10 + 3*4
    });
  });

  describe('ARM load/store', () => {
    it('LDR Rd, [Rn, #offset]', () => {
      const { cpu, mem } = setupArmCpu([
        armLdrImm(0, 1, 4), // ldr r0, [r1, #4]
        armBx(LR),
      ]);
      cpu.registers[1] = 0x02000000;
      mem.write32(0x02000004, 0xdeadbeef);
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0xdeadbeef);
    });

    it('STR Rd, [Rn, #offset]', () => {
      const { cpu, mem } = setupArmCpu([
        armStrImm(0, 1, 0), // str r0, [r1, #0]
        armBx(LR),
      ]);
      cpu.registers[0] = 0xcafebabe;
      cpu.registers[1] = 0x02000000;
      cpu.run(100);
      expect(mem.read32(0x02000000)).toBe(0xcafebabe);
    });

    it('LDRB Rd, [Rn, #offset]', () => {
      const { cpu, mem } = setupArmCpu([
        armLdrbImm(0, 1, 0), // ldrb r0, [r1, #0]
        armBx(LR),
      ]);
      cpu.registers[1] = 0x02000000;
      mem.write8(0x02000000, 0xab);
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0xab);
    });

    it('STRB Rd, [Rn, #offset]', () => {
      const { cpu, mem } = setupArmCpu([
        armStrbImm(0, 1, 0), // strb r0, [r1, #0]
        armBx(LR),
      ]);
      cpu.registers[0] = 0x12345678;
      cpu.registers[1] = 0x02000000;
      cpu.run(100);
      expect(mem.read8(0x02000000)).toBe(0x78);
    });

    it('LDRH Rd, [Rn, #offset]', () => {
      const { cpu, mem } = setupArmCpu([
        armLdrhImm(0, 1, 2), // ldrh r0, [r1, #2]
        armBx(LR),
      ]);
      cpu.registers[1] = 0x02000000;
      mem.write16(0x02000002, 0xabcd);
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0xabcd);
    });

    it('STRH Rd, [Rn, #offset]', () => {
      const { cpu, mem } = setupArmCpu([
        armStrhImm(0, 1, 0), // strh r0, [r1, #0]
        armBx(LR),
      ]);
      cpu.registers[0] = 0x12345678;
      cpu.registers[1] = 0x02000000;
      cpu.run(100);
      expect(mem.read16(0x02000000)).toBe(0x5678);
    });

    it('LDR with pre-indexed writeback', () => {
      // LDR r0, [r1, #4]! (pre-indexed with writeback)
      const instr =
        (AL << 28) | (0x01 << 26) | (1 << 24) | (1 << 23) | (1 << 21) | (1 << 20) | (1 << 16) | (0 << 12) | 4;
      const { cpu, mem } = setupArmCpu([instr, armBx(LR)]);
      cpu.registers[1] = 0x02000000;
      mem.write32(0x02000004, 0xaabbccdd);
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0xaabbccdd);
      expect(cpu.registers[1]).toBe(0x02000004); // writeback
    });

    it('LDR with post-indexed offset', () => {
      // LDR r0, [r1], #4 (post-indexed)
      const instr = (AL << 28) | (0x01 << 26) | (0 << 24) | (1 << 23) | (1 << 20) | (1 << 16) | (0 << 12) | 4;
      const { cpu, mem } = setupArmCpu([instr, armBx(LR)]);
      cpu.registers[1] = 0x02000000;
      mem.write32(0x02000000, 0x11223344);
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0x11223344);
      expect(cpu.registers[1]).toBe(0x02000004); // post-index writeback
    });
  });

  describe('ARM branch', () => {
    it('B forward', () => {
      const { cpu } = setupArmCpu([
        armB(0), // b +0 (skip next), PC+8+0 = instrAddr+8
        armMovImm(0, 1), // should be skipped
        armMovImm(0, 2), // target
        armBx(LR),
      ]);
      cpu.run(100);
      expect(cpu.registers[0]).toBe(2);
    });

    it('BL sets LR and branches', () => {
      // Save sentinel LR in r4, then BL to a function, return, halt via sentinel
      const { cpu } = setupArmCpu([
        armMovReg(4, LR), // 0x00: save SENTINEL to r4
        armBl(0), // 0x04: BL +0 (target = PC+8 = instrAddr+8 = 0x0C)
        armBx(4), // 0x08: after return, BX r4 → SENTINEL (halt)
        armMovImm(0, 42), // 0x0C: function body
        armBx(LR), // 0x10: return to LR = 0x08
      ]);
      cpu.run(100);
      expect(cpu.registers[0]).toBe(42);
      // LR should be instrAddr(BL) + 4 (return address after BL)
      expect(cpu.registers[LR]).toBe(0x08000008);
    });

    it('BX to Thumb mode', () => {
      const mem = new GbaMemory();
      const cpu = new ArmCpu(mem);

      // ARM code at 0x08000000: just BX r1
      loadArmInstructions(mem, 0x08000000, [
        armBx(1), // bx r1 — switch to Thumb
      ]);

      // Thumb code at 0x08000100
      loadThumbInstructions(mem, 0x08000100, [
        0x2020, // movs r0, #0x20
        0x4770, // bx lr
      ]);

      cpu.cpsr = MODE_SYS;
      cpu.registers[PC] = 0x08000000;
      cpu.registers[1] = 0x08000101; // Thumb address (bit 0 set)
      cpu.registers[LR] = SENTINEL_ADDR | 1;
      cpu.registers[SP] = 0x03007f00;

      cpu.run(100);
      expect(cpu.registers[0]).toBe(0x20);
      expect(cpu.getT()).toBe(true);
    });
  });

  describe('ARM block data transfer (LDM/STM)', () => {
    it('STMIA: store multiple increment after', () => {
      // STMIA r0!, {r1, r2, r3}
      const instr = armBlockTransfer(false, false, true, true, 0, (1 << 1) | (1 << 2) | (1 << 3));
      const { cpu, mem } = setupArmCpu([instr, armBx(LR)]);
      cpu.registers[0] = 0x02000000;
      cpu.registers[1] = 0x11;
      cpu.registers[2] = 0x22;
      cpu.registers[3] = 0x33;
      cpu.run(100);
      expect(mem.read32(0x02000000)).toBe(0x11);
      expect(mem.read32(0x02000004)).toBe(0x22);
      expect(mem.read32(0x02000008)).toBe(0x33);
      expect(cpu.registers[0]).toBe(0x0200000c); // writeback
    });

    it('LDMIA: load multiple increment after', () => {
      const instr = armBlockTransfer(true, false, true, true, 0, (1 << 1) | (1 << 2) | (1 << 3));
      const { cpu, mem } = setupArmCpu([instr, armBx(LR)]);
      cpu.registers[0] = 0x02000000;
      mem.write32(0x02000000, 0xaa);
      mem.write32(0x02000004, 0xbb);
      mem.write32(0x02000008, 0xcc);
      cpu.run(100);
      expect(cpu.registers[1]).toBe(0xaa);
      expect(cpu.registers[2]).toBe(0xbb);
      expect(cpu.registers[3]).toBe(0xcc);
      expect(cpu.registers[0]).toBe(0x0200000c);
    });

    it('STMDB: store multiple decrement before', () => {
      // STMDB r0!, {r1, r2} (push-style)
      const instr = armBlockTransfer(false, true, false, true, 0, (1 << 1) | (1 << 2));
      const { cpu, mem } = setupArmCpu([instr, armBx(LR)]);
      cpu.registers[0] = 0x02000010;
      cpu.registers[1] = 0x11;
      cpu.registers[2] = 0x22;
      cpu.run(100);
      expect(mem.read32(0x02000008)).toBe(0x11);
      expect(mem.read32(0x0200000c)).toBe(0x22);
      expect(cpu.registers[0]).toBe(0x02000008); // writeback
    });

    it('LDMDB: load multiple decrement before', () => {
      const instr = armBlockTransfer(true, true, false, true, 0, (1 << 1) | (1 << 2));
      const { cpu, mem } = setupArmCpu([instr, armBx(LR)]);
      cpu.registers[0] = 0x02000010;
      mem.write32(0x02000008, 0xaa);
      mem.write32(0x0200000c, 0xbb);
      cpu.run(100);
      expect(cpu.registers[1]).toBe(0xaa);
      expect(cpu.registers[2]).toBe(0xbb);
      expect(cpu.registers[0]).toBe(0x02000008);
    });
  });

  describe('ARM multiply', () => {
    it('MUL Rd, Rm, Rs', () => {
      const { cpu } = setupArmCpu([
        armMul(0, 1, 2), // mul r0, r1, r2
        armBx(LR),
      ]);
      cpu.registers[1] = 7;
      cpu.registers[2] = 6;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(42);
    });

    it('MLA Rd, Rm, Rs, Rn', () => {
      const { cpu } = setupArmCpu([
        armMla(0, 1, 2, 3), // mla r0, r1, r2, r3
        armBx(LR),
      ]);
      cpu.registers[1] = 5;
      cpu.registers[2] = 6;
      cpu.registers[3] = 12;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(42); // 5*6 + 12
    });

    it('MULS sets Z flag', () => {
      const { cpu } = setupArmCpu([
        armMul(0, 1, 2, 1), // muls r0, r1, r2
        armBx(LR),
      ]);
      cpu.registers[1] = 0;
      cpu.registers[2] = 100;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0);
      expect(cpu.getZ()).toBe(true);
    });
  });

  describe('condition codes', () => {
    it('EQ: executes when Z set', () => {
      const { cpu } = setupArmCpu([
        armCmpImm(0, 5), // cmp r0, #5 — sets Z
        armCondDP(0x0, 0xd, 0, 0, 1, 42, true), // moveq r1, #42
        armBx(LR),
      ]);
      cpu.registers[0] = 5;
      cpu.run(100);
      expect(cpu.registers[1]).toBe(42);
    });

    it('EQ: skips when Z clear', () => {
      const { cpu } = setupArmCpu([
        armCmpImm(0, 5),
        armCondDP(0x0, 0xd, 0, 0, 1, 42, true), // moveq r1, #42
        armBx(LR),
      ]);
      cpu.registers[0] = 3;
      cpu.registers[1] = 0;
      cpu.run(100);
      expect(cpu.registers[1]).toBe(0); // not executed
    });

    it('NE: executes when Z clear', () => {
      const { cpu } = setupArmCpu([
        armCmpImm(0, 5),
        armCondDP(0x1, 0xd, 0, 0, 1, 99, true), // movne r1, #99
        armBx(LR),
      ]);
      cpu.registers[0] = 3;
      cpu.run(100);
      expect(cpu.registers[1]).toBe(99);
    });

    it('GT: executes when Z=0 and N=V', () => {
      const { cpu } = setupArmCpu([
        armCmpImm(0, 3), // cmp r0, #3 (10 > 3)
        armCondDP(0xc, 0xd, 0, 0, 1, 77, true), // movgt r1, #77
        armBx(LR),
      ]);
      cpu.registers[0] = 10;
      cpu.run(100);
      expect(cpu.registers[1]).toBe(77);
    });

    it('LT: executes when N!=V', () => {
      const { cpu } = setupArmCpu([
        armCmpImm(0, 100), // cmp r0, #100 (5 < 100)
        armCondDP(0xb, 0xd, 0, 0, 1, 55, true), // movlt r1, #55
        armBx(LR),
      ]);
      cpu.registers[0] = 5;
      cpu.run(100);
      expect(cpu.registers[1]).toBe(55);
    });
  });

  describe('Thumb ↔ ARM mode transitions', () => {
    it('BX from Thumb to ARM mode', () => {
      const mem = new GbaMemory();
      const cpu = new ArmCpu(mem);

      // Thumb code at 0x08000000
      loadThumbInstructions(mem, 0x08000000, [
        0x4708, // bx r1
      ]);

      // ARM code at 0x08000100
      loadArmInstructions(mem, 0x08000100, [
        armMovImm(0, 99), // mov r0, #99
        armBx(LR), // bx lr
      ]);

      cpu.cpsr = MODE_SYS | (1 << 5); // Start in Thumb
      cpu.registers[PC] = 0x08000000;
      cpu.registers[1] = 0x08000100; // ARM address (bit 0 clear)
      cpu.registers[LR] = SENTINEL_ADDR;
      cpu.registers[SP] = 0x03007f00;

      cpu.run(100);
      expect(cpu.registers[0]).toBe(99);
      expect(cpu.getT()).toBe(false); // Back in ARM mode
    });

    it('round-trip: ARM → Thumb → ARM', () => {
      const mem = new GbaMemory();
      const cpu = new ArmCpu(mem);

      // ARM code at 0x08000000
      loadArmInstructions(mem, 0x08000000, [
        armBx(1), // bx r1 — go to Thumb
      ]);

      // Thumb code at 0x08000100
      loadThumbInstructions(mem, 0x08000100, [
        0x2020, // movs r0, #0x20
        0x4710, // bx r2 — go back to ARM
      ]);

      // ARM code at 0x08000200
      loadArmInstructions(mem, 0x08000200, [
        armAddImm(0, 0, 1), // add r0, r0, #1
        armBx(LR), // return
      ]);

      cpu.cpsr = MODE_SYS;
      cpu.registers[PC] = 0x08000000;
      cpu.registers[1] = 0x08000101; // Thumb (bit 0 set)
      cpu.registers[2] = 0x08000200; // ARM (bit 0 clear)
      cpu.registers[LR] = SENTINEL_ADDR;
      cpu.registers[SP] = 0x03007f00;

      cpu.run(100);
      expect(cpu.registers[0]).toBe(0x21); // 0x20 + 1
    });
  });

  describe('CPU mode switching', () => {
    it('switches to SVC mode and banks SP/LR', () => {
      const { cpu } = setupArmCpu([armBx(LR)]); // just so we have something
      cpu.registers[SP] = 0x03007f00;
      cpu.registers[LR] = 0x12345678;

      cpu.switchMode(MODE_SVC);
      expect(cpu.getMode()).toBe(MODE_SVC);

      // SVC mode has its own SP/LR (initialized to 0)
      expect(cpu.registers[SP]).toBe(0);
      expect(cpu.registers[LR]).toBe(0);

      // Set SVC SP/LR
      cpu.registers[SP] = 0x03007e00;
      cpu.registers[LR] = 0xabcdef00;

      // Switch back to SYS
      cpu.switchMode(MODE_SYS);
      expect(cpu.getMode()).toBe(MODE_SYS);

      // Original SP/LR restored
      expect(cpu.registers[SP]).toBe(0x03007f00);
      expect(cpu.registers[LR]).toBe(0x12345678);

      // Switch to SVC again — should restore SVC values
      cpu.switchMode(MODE_SVC);
      expect(cpu.registers[SP]).toBe(0x03007e00);
      expect(cpu.registers[LR]).toBe(0xabcdef00);
    });

    it('FIQ mode banks r8-r14', () => {
      const { cpu } = setupArmCpu([armBx(LR)]);
      cpu.registers[8] = 0x88;
      cpu.registers[9] = 0x99;
      cpu.registers[10] = 0xaa;
      cpu.registers[11] = 0xbb;
      cpu.registers[12] = 0xcc;
      cpu.registers[SP] = 0x03007f00;
      cpu.registers[LR] = 0x12345678;

      cpu.switchMode(MODE_FIQ);
      // FIQ has its own r8-r14
      expect(cpu.registers[8]).toBe(0);
      expect(cpu.registers[9]).toBe(0);

      cpu.registers[8] = 0xf8;
      cpu.registers[9] = 0xf9;

      cpu.switchMode(MODE_SYS);
      // USR r8-r12 restored
      expect(cpu.registers[8]).toBe(0x88);
      expect(cpu.registers[9]).toBe(0x99);
      expect(cpu.registers[SP]).toBe(0x03007f00);
    });

    it('SPSR is per-mode', () => {
      const { cpu } = setupArmCpu([armBx(LR)]);

      cpu.switchMode(MODE_SVC);
      cpu.setSPSR(0xdeadbeef);
      expect(cpu.getSPSR()).toBe(0xdeadbeef);

      cpu.switchMode(MODE_IRQ);
      expect(cpu.getSPSR()).toBe(0); // IRQ SPSR is separate
      cpu.setSPSR(0xcafebabe);

      cpu.switchMode(MODE_SVC);
      expect(cpu.getSPSR()).toBe(0xdeadbeef); // SVC SPSR unchanged

      cpu.switchMode(MODE_SYS);
      expect(cpu.getSPSR()).toBe(0); // SYS has no SPSR
    });
  });

  describe('Thumb mode execution', () => {
    it('runs basic Thumb instructions', () => {
      const { cpu } = setupThumbCpu([
        0x200a, // movs r0, #10
        0x2114, // movs r1, #20
        0x1840, // adds r0, r0, r1
        0x4770, // bx lr
      ]);
      cpu.run(100);
      expect(cpu.registers[0]).toBe(30);
    });

    it('Thumb push/pop works', () => {
      const { cpu } = setupThumbCpu([
        0x2042, // movs r0, #0x42
        0xb401, // push {r0}
        0x2000, // movs r0, #0
        0xbc01, // pop {r0}
        0x4770, // bx lr
      ]);
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0x42);
    });
  });

  describe('ARM MRS/MSR', () => {
    it('MRS reads CPSR', () => {
      // MRS r0, CPSR: 0xE10F0000
      const { cpu } = setupArmCpu([
        0xe10f0000, // mrs r0, cpsr
        armBx(LR),
      ]);
      cpu.cpsr = MODE_SYS | (1 << 30); // Z flag set
      cpu.run(100);
      expect(cpu.registers[0]).toBe(MODE_SYS | (1 << 30));
    });

    it('MSR writes CPSR flags', () => {
      // MSR CPSR_f, #0xF0000000 (set all condition flags)
      // Encoding: cond=AL, 0011_0010_1000_1111_xxxx_xxxx_xxxx_xxxx
      // 0xE328F00F with rotate=2 (rotate 0x0F by 4) -> need 0xF0000000
      // imm8=0xF0, rotate=2 (rotate right by 4) = 0xF0000000? No.
      // 0xF0 rotated right by 4 = 0x0F000000. That's wrong.
      // Let's use: imm8=0x0F, rotate=2 => ROR by 4 => 0xF0000000
      const instr = 0xe328f20f; // MSR CPSR_f, #0xF0000000
      const { cpu } = setupArmCpu([instr, armBx(LR)]);
      cpu.run(100);
      expect(cpu.getN()).toBe(true);
      expect(cpu.getZ()).toBe(true);
      expect(cpu.getC()).toBe(true);
      expect(cpu.getV()).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('MOV with immediate rotation', () => {
      // MOV r0, #(0xFF ROR 30)
      // imm8=0xFF, rotate=15 => ROR by 30
      // ROR(0xFF, 30) = (0xFF >>> 30) | (0xFF << 2) = 0x3 | 0x3FC = 0x3FC
      // Note: 0xFF << 2 = 0x3FC (bits above 0xFF shifted out), and 0xFF >>> 30 = 0
      // Actually: (0xFF >>> 30) = 0x00000003 (only bottom 8 bits, so >>> 30 = 0 for 8-bit 0xFF)
      // Wait, JS numbers: 0xFF >>> 30 = 0. So result = 0 | 0x3FC = 0x3FC
      const instr = (AL << 28) | (1 << 25) | (0xd << 21) | (0 << 12) | (15 << 8) | 0xff;
      const { cpu } = setupArmCpu([instr, armBx(LR)]);
      cpu.run(100);
      expect(cpu.registers[0]).toBe(0x3fc);
    });

    it('conditional execution: multiple conditions in sequence', () => {
      const { cpu } = setupArmCpu([
        armMovImm(0, 10),
        armCmpImm(0, 5),
        // r0 > 5, so GT should fire
        armCondDP(0xc, 0xd, 0, 0, 1, 1, true), // movgt r1, #1
        armCondDP(0xb, 0xd, 0, 0, 2, 1, true), // movlt r2, #1
        armCondDP(0x0, 0xd, 0, 0, 3, 1, true), // moveq r3, #1
        armBx(LR),
      ]);
      cpu.registers[1] = 0;
      cpu.registers[2] = 0;
      cpu.registers[3] = 0;
      cpu.run(100);
      expect(cpu.registers[1]).toBe(1); // GT: true
      expect(cpu.registers[2]).toBe(0); // LT: false
      expect(cpu.registers[3]).toBe(0); // EQ: false
    });
  });
  describe('THUMB block transfer with an empty register list', () => {
    // THUMB.15 encoding: 1100 L Rb Rlist. Rlist == 0 is encodable, and ARM7TDMI does not treat it
    // as a no-op — it transfers R15 and advances the base by 0x40.
    //
    //   GBATEK, THUMB.15: "Empty Rlist: R15 loaded/stored (ARMv4 only), and Rb=Rb+40h (ARMv4-v5)."
    //
    // mGBA implements the same quirk in its STM_LOOP/LDM_LOOP macros (src/gba/memory.c): an
    // `if (UNLIKELY(!mask))` arm that transfers the PC and does `address += 64` before the
    // per-register loop. This emulator previously did neither: the loop simply did not run and
    // the base was left untouched.
    const DATA = 0x02001000;

    it('STMIA with an empty list stores the PC and adds 0x40 to the base', () => {
      const { cpu, mem } = setupThumbCpu([0xc100]); // stmia r1!, {}
      cpu.registers[1] = DATA;
      cpu.step();
      // The stored value is the pipeline PC (instrAddr+4) plus one instruction width, which is
      // what mGBA stores as `cpu->gprs[ARM_PC] + WORD_SIZE_THUMB`.
      expect(mem.read32(DATA)).toBe(0x08000006);
      expect(cpu.registers[1]).toBe(DATA + 0x40);
    });

    it('LDMIA with an empty list loads the PC and adds 0x40 to the base', () => {
      const { cpu, mem } = setupThumbCpu([0xc900]); // ldmia r1!, {}
      cpu.registers[1] = DATA;
      mem.write32(DATA, 0x08000123);
      cpu.step();
      expect(cpu.registers[PC]).toBe(0x08000122); // halfword-aligned, Thumb bit dropped
      expect(cpu.registers[1]).toBe(DATA + 0x40);
    });

    it('a NON-empty list is unaffected', () => {
      // 0xC102: STMIA (bit 11 = 0), Rb = r1, Rlist = 0x02 = {r1} — the base is in its own list and
      // is the lowest entry, which is the DEFINED case: the old base is stored. Guards against the
      // empty-list arm swallowing ordinary transfers.
      const { cpu, mem } = setupThumbCpu([0xc102]);
      cpu.registers[1] = DATA;
      cpu.step();
      expect(cpu.registers[1]).toBe(DATA + 4); // one transfer, not 0x40
      expect(mem.read32(DATA)).toBe(DATA); // old base, per GBATEK's "Rb is FIRST entry" rule
    });
  });
});
