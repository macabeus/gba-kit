import { describe, expect, it } from 'vitest';

import { ArmCpu, MODE_FIQ, MODE_IRQ, MODE_SVC, MODE_SYS, MODE_UND, MODE_USR } from '../arm-cpu.js';
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

  describe('SWI exception', () => {
    // GBATEK "ARM CPU Exceptions": SWI enters SVC mode with R14_svc = the address after the SWI,
    // SPSR_svc = the old CPSR, I set, T clear, and PC = 0x08.
    const takeException = (): number | null => null;

    it('a handler that returns null leaves an ARM SWI to the vector', () => {
      const mem = new GbaMemory();
      const cpu = new ArmCpu(mem, { swiHandler: takeException });
      loadArmInstructions(mem, 0x08000000, [0xef050000 /* swi 0x50000 */]);
      cpu.cpsr = MODE_SYS | (1 << 29); // C set: the SPSR keeps the flags
      cpu.registers[PC] = 0x08000000;
      const cycles = cpu.step();
      expect(cpu.getMode()).toBe(MODE_SVC);
      expect(cpu.registers[PC]).toBe(0x08);
      expect(cpu.registers[LR]).toBe(0x08000004);
      expect(cpu.getSPSR()).toBe(MODE_SYS | (1 << 29));
      expect(cpu.irqDisabled()).toBe(true);
      expect(cycles).toBe(3); // 2S+1N, like a branch
    });

    it('a Thumb SWI enters ARM state with the return address after the halfword', () => {
      const mem = new GbaMemory();
      const cpu = new ArmCpu(mem, { swiHandler: takeException });
      loadThumbInstructions(mem, 0x08000000, [0xdf05 /* swi 5 */]);
      cpu.cpsr = MODE_SYS | (1 << 5);
      cpu.registers[PC] = 0x08000000;
      cpu.step();
      expect(cpu.getT()).toBe(false);
      expect(cpu.registers[PC]).toBe(0x08);
      expect(cpu.registers[LR]).toBe(0x08000002);
      expect(cpu.getSPSR()).toBe(MODE_SYS | (1 << 5));
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
    // per-register loop.
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

  describe('prefetch pipeline', () => {
    // GBATEK "ARM CPU Overview": while the instruction at $ executes, $+4 is decoded and $+8 is
    // fetched (Thumb: $+2 and $+4), so a store to either changes nothing until the pipeline
    // refills. mGBA keeps the same two words in cpu->prefetch[0..1]; jsmolka nes.gba test 1.
    const MOV_R0_5 = 0xe3a00005;
    const CODE = 0x03000000;

    it('executes the instructions already in the pipeline, not the ones stored over them', () => {
      const { cpu, mem } = setupArmCpu(
        [
          0xe58f1000, // str r1, [pc]        ; [$+8] = mov r0, #5
          0xe58f1000, // str r1, [pc]        ; [$+8] = mov r0, #5
          armMovImm(0, 1), // overwritten while in the pipeline
          armMovImm(2, 1), // overwritten while in the pipeline
          armBx(LR),
        ],
        CODE,
      );
      cpu.registers[1] = MOV_R0_5;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(1);
      expect(cpu.registers[2]).toBe(1);
      expect(mem.read32(CODE + 8)).toBe(MOV_R0_5);
      expect(mem.read32(CODE + 12)).toBe(MOV_R0_5);
    });

    it('executes a store three instructions ahead, which is not fetched yet', () => {
      const { cpu } = setupArmCpu(
        [
          0xe58f1004, // str r1, [pc, #4]    ; [$+12] = mov r0, #5
          armMovImm(0, 1),
          armMovImm(2, 2),
          armMovImm(0, 3), // replaced before it is fetched
          armBx(LR),
        ],
        CODE,
      );
      cpu.registers[1] = MOV_R0_5;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(5);
    });

    it('refills on a branch, even one to the next instruction', () => {
      const { cpu } = setupArmCpu(
        [
          0xe58f1000, // str r1, [pc]        ; [$+8] = mov r0, #5
          armB(-1), // b $+4: the next instruction, refetched
          armMovImm(0, 1),
          armBx(LR),
        ],
        CODE,
      );
      cpu.registers[1] = MOV_R0_5;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(5);
    });

    it('refills when the PC is set from outside the CPU', () => {
      const { cpu, mem } = setupArmCpu([armMovImm(0, 1), armBx(LR)], CODE);
      cpu.step();
      mem.write32(CODE, MOV_R0_5);
      cpu.registers[PC] = CODE;
      cpu.step();
      expect(cpu.registers[0]).toBe(5);
    });

    it('models the Thumb pipeline as two halfwords ahead', () => {
      const { cpu } = setupThumbCpu(
        [
          0x8019, // strh r1, [r3]          ; r3 = $+4
          0x46c0, // nop
          0x2001, // movs r0, #1            ; overwritten while in the pipeline
          0x4770, // bx lr
        ],
        CODE,
      );
      cpu.registers[1] = 0x2005; // movs r0, #5
      cpu.registers[3] = CODE + 4;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(1);
    });

    it('refills after an HLE software interrupt, as the BIOS return does', () => {
      const mem = new GbaMemory();
      const cpu = new ArmCpu(mem, {
        // A BIOS call that writes the code it returns to (CpuSet over the caller, say).
        swiHandler: (c) => {
          mem.write32(c.registers[PC]!, MOV_R0_5);
          return 0;
        },
      });
      loadArmInstructions(mem, CODE, [0xef010000 /* swi 0x10000 */, armMovImm(0, 1), armBx(LR)]);
      cpu.cpsr = MODE_SYS;
      cpu.registers[PC] = CODE;
      cpu.registers[LR] = SENTINEL_ADDR;
      cpu.run(100);
      expect(cpu.registers[0]).toBe(5);
    });

    it('exposes the decoded and fetched opcodes while an instruction executes', () => {
      const words = [armMovImm(0, 1), armMovImm(1, 2), armMovImm(2, 3), armMovImm(3, 4)];
      const { cpu } = setupArmCpu(words, CODE);
      const seen: number[][] = [];
      cpu.setDebugHooks({
        onInstructionPost: () => seen.push([cpu.decodedOpcode, cpu.prefetchedOpcode]),
      });
      cpu.step();
      // While the instruction at $ ran, [$+4] was decoded and [$+8] fetched.
      expect(seen[0]).toEqual([words[1]! >>> 0, words[2]! >>> 0]);
    });

    it('keeps the pipeline across a refused instruction (a debugger stop)', () => {
      const { cpu } = setupArmCpu([0xe58f1000 /* str r1, [pc] */, armMovImm(2, 2), armMovImm(0, 1), armBx(LR)], CODE);
      cpu.registers[1] = MOV_R0_5;
      let refuse = true;
      cpu.setDebugHooks({
        onInstructionPre: (address) => {
          if (address === CODE + 8 && refuse) {
            refuse = false;
            return 'break';
          }
          return 'continue';
        },
      });
      cpu.run(100);
      expect(cpu.registers[PC]).toBe(CODE + 8);
      cpu.run(100);
      expect(cpu.registers[0]).toBe(1);
    });

    it('carries the pipeline through a snapshot; an older snapshot refills from memory', () => {
      const program = [0xe58f1000 /* str r1, [pc] */, armMovImm(2, 2), armMovImm(0, 1), armBx(LR)];
      const { cpu, mem } = setupArmCpu(program, CODE);
      cpu.registers[1] = MOV_R0_5;
      cpu.step(); // the store: [CODE+8] is now mov r0, #5, the pipeline still holds mov r0, #1
      const snap = cpu.serialize();
      expect(Array.from(snap.pipeline!)).toEqual([CODE + 4, program[1]! >>> 0, program[2]! >>> 0, 0]);

      const restored = new ArmCpu(mem);
      restored.deserialize(snap);
      restored.run(100);
      expect(restored.registers[0]).toBe(1);

      const legacy = { ...snap };
      delete legacy.pipeline;
      const fromLegacy = new ArmCpu(mem);
      fromLegacy.deserialize(legacy);
      fromLegacy.run(100);
      expect(fromLegacy.registers[0]).toBe(5);
    });
  });

  describe('stores of R15', () => {
    // GBATEK "ARM.9"/"ARM.10"/"ARM.11": a stored R15 is the instruction address + 12. mGBA stores
    // gprs[PC] (+8) plus WORD_SIZE_ARM. jsmolka arm.gba tests 356 and 510.
    const DATA = 0x02000100;
    const CODE = 0x08000000;

    it('STR stores the instruction address + 12', () => {
      const { cpu, mem } = setupArmCpu([0xe580f000 /* str pc, [r0] */, armBx(LR)], CODE);
      cpu.registers[0] = DATA;
      cpu.run(10);
      expect(mem.read32(DATA)).toBe(CODE + 12);
    });

    it('STRH stores the low half of the instruction address + 12', () => {
      const { cpu, mem } = setupArmCpu([0xe1c0f0b0 /* strh pc, [r0] */, armBx(LR)], CODE);
      cpu.registers[0] = DATA;
      cpu.run(10);
      expect(mem.read16(DATA)).toBe((CODE + 12) & 0xffff);
    });

    it('STM stores the instruction address + 12', () => {
      const { cpu, mem } = setupArmCpu([0xe8808000 /* stmia r0, {pc} */, armBx(LR)], CODE);
      cpu.registers[0] = DATA;
      cpu.run(10);
      expect(mem.read32(DATA)).toBe(CODE + 12);
    });
  });

  describe('load with writeback into its own base', () => {
    // On ARM7TDMI the base writeback happens before the loaded data lands, so the data wins
    // (mGBA ADDR_MODE_2_WRITEBACK_PRE_LOAD; jsmolka arm.gba tests 360/361, 412/413).
    const DATA = 0x02000100;

    it.each([
      ['ldr r0, [r0, #4]!', 0xe5b00004, DATA + 4],
      ['ldr r0, [r0], #4', 0xe4900004, DATA],
      ['ldrh r0, [r0, #2]!', 0xe1f000b2, DATA + 2],
    ])('%s keeps the loaded value', (_name, instr, loadedFrom) => {
      const { cpu, mem } = setupArmCpu([instr, armBx(LR)]);
      mem.write32(DATA, 0x11112222);
      mem.write32(DATA + 4, 0x33334444);
      cpu.registers[0] = DATA;
      cpu.run(10);
      const expected = instr === 0xe1f000b2 ? mem.read16(loadedFrom) : mem.read32(loadedFrom);
      expect(cpu.registers[0]).toBe(expected);
    });
  });

  describe('misaligned loads over a bus that only aligns', () => {
    // MemoryBus returns aligned data; the CPU rotates. GBATEK "ARM.9", "THUMB.8", "THUMB.10";
    // mGBA LOAD_16/LOAD_32 ROR. jsmolka thumb.gba test 211.
    const BASE = 0x02000100;
    function withBytes(cpu: ArmCpu, mem: GbaMemory): void {
      mem.loadBytes(BASE, Uint8Array.of(0x11, 0x22, 0x33, 0x44));
      cpu.registers[0] = BASE;
    }

    it('Thumb LDRH (register offset) rotates an odd halfword', () => {
      const { cpu, mem } = setupThumbCpu([0x5a81 /* ldrh r1, [r0, r2] */, 0x4770]);
      withBytes(cpu, mem);
      cpu.registers[2] = 1;
      cpu.run(10);
      expect(cpu.registers[1]).toBe(0x11000022);
    });

    it('Thumb LDRH (immediate offset) rotates an odd halfword', () => {
      const { cpu, mem } = setupThumbCpu([0x8841 /* ldrh r1, [r0, #2] */, 0x4770]);
      withBytes(cpu, mem);
      cpu.registers[0] = BASE + 1;
      cpu.run(10);
      expect(cpu.registers[1]).toBe(0x33000044);
    });

    it('Thumb LDR [sp] rotates a misaligned word', () => {
      const { cpu, mem } = setupThumbCpu([0x9900 /* ldr r1, [sp, #0] */, 0x4770]);
      withBytes(cpu, mem);
      cpu.registers[SP] = BASE + 1;
      cpu.run(10);
      expect(cpu.registers[1]).toBe(0x11443322);
    });

    it('Thumb and ARM LDRSH at an odd address sign-extend the addressed byte', () => {
      const thumb = setupThumbCpu([0x5e81 /* ldrsh r1, [r0, r2] */, 0x4770]);
      thumb.mem.loadBytes(BASE, Uint8Array.of(0x11, 0x80));
      thumb.cpu.registers[0] = BASE;
      thumb.cpu.registers[2] = 1;
      thumb.cpu.run(10);
      expect(thumb.cpu.registers[1]).toBe(0xffffff80);

      const arm = setupArmCpu([0xe1d010f0 /* ldrsh r1, [r0] */, armBx(LR)]);
      arm.mem.loadBytes(BASE, Uint8Array.of(0x11, 0x22));
      arm.cpu.registers[0] = BASE + 1;
      arm.cpu.run(10);
      expect(arm.cpu.registers[1]).toBe(0x22);
    });

    it('ARM LDRH and SWP rotate like the loads they are', () => {
      const ldrh = setupArmCpu([0xe1d010b0 /* ldrh r1, [r0] */, armBx(LR)]);
      withBytes(ldrh.cpu, ldrh.mem);
      ldrh.cpu.registers[0] = BASE + 3;
      ldrh.cpu.run(10);
      expect(ldrh.cpu.registers[1]).toBe(0x33000044);

      const swp = setupArmCpu([0xe1001092 /* swp r1, r2, [r0] */, armBx(LR)]);
      withBytes(swp.cpu, swp.mem);
      swp.cpu.registers[0] = BASE + 2;
      swp.cpu.registers[2] = 0xcafef00d;
      swp.cpu.run(10);
      expect(swp.cpu.registers[1]).toBe(0x22114433);
      expect(swp.mem.read32(BASE)).toBe(0xcafef00d);
    });

    it('passes stores the address they name, which the bus aligns', () => {
      class RecordingMemory extends GbaMemory {
        readonly stores: [number, number][] = [];
        override write16(address: number, value: number): void {
          this.stores.push([2, address]);
          super.write16(address, value);
        }
        override write32(address: number, value: number): void {
          this.stores.push([4, address]);
          super.write32(address, value);
        }
      }
      const mem = new RecordingMemory();
      const cpu = new ArmCpu(mem);
      loadArmInstructions(mem, 0x08000000, [0xe5801001 /* str r1, [r0, #1] */, 0xe1c010b1 /* strh r1, [r0, #1] */]);
      cpu.cpsr = MODE_SYS;
      cpu.registers[PC] = 0x08000000;
      cpu.registers[0] = BASE;
      cpu.registers[1] = 0xaabbccdd;
      cpu.step();
      cpu.step();
      expect(mem.stores).toEqual([
        [4, BASE + 1],
        [2, BASE + 1],
      ]);
      // Both land on the aligned addresses the 32-bit memory decodes.
      expect(mem.read32(BASE)).toBe(0xaabbccdd);
      expect(mem.read32(BASE + 4)).toBe(0);
    });
  });

  describe('block transfer edge cases', () => {
    // GBATEK "ARM.11 Block Data Transfer", "THUMB.14", "THUMB.15"; jsmolka arm.gba 510-532.
    const BASE = 0x02000100;

    it('STM^ stores the User bank from FIQ mode', () => {
      const { cpu, mem } = setupArmCpu([0xe8c00100 /* stmia r0, {r8}^ */, armBx(LR)]);
      cpu.registers[8] = 0xaaaa;
      cpu.switchMode(MODE_FIQ);
      cpu.registers[8] = 0xbbbb;
      cpu.registers[0] = BASE;
      cpu.registers[LR] = SENTINEL_ADDR;
      cpu.run(10);
      expect(mem.read32(BASE)).toBe(0xaaaa);
    });

    it('LDM^ without R15 loads the User bank from IRQ mode', () => {
      const { cpu, mem } = setupArmCpu([0xe8d02000 /* ldmia r0, {sp}^ */, armBx(LR)]);
      cpu.switchMode(MODE_IRQ);
      cpu.registers[SP] = 0x2222;
      cpu.registers[LR] = SENTINEL_ADDR;
      cpu.registers[0] = BASE;
      mem.write32(BASE, 0x1234);
      cpu.run(10);
      expect(cpu.registers[SP]).toBe(0x2222);
      expect(cpu.getBankedSP(MODE_SYS)).toBe(0x1234);
    });

    it('LDM {pc}^ writes the base back in its own mode and returns to a Thumb halfword', () => {
      const { cpu, mem } = setupArmCpu([0xe8fd8001 /* ldmfd sp!, {r0, pc}^ */]);
      cpu.registers[SP] = 0x03007f00; // SYS stack, which the return must leave alone
      cpu.switchMode(MODE_IRQ);
      cpu.registers[SP] = 0x03007000;
      cpu.setSPSR(MODE_SYS | (1 << 5));
      mem.write32(0x03007000, 0x77);
      mem.write32(0x03007004, 0x08000102);
      cpu.step();
      expect(cpu.getMode()).toBe(MODE_SYS);
      expect(cpu.getT()).toBe(true);
      expect(cpu.registers[PC]).toBe(0x08000102);
      expect(cpu.registers[0]).toBe(0x77);
      expect(cpu.registers[SP]).toBe(0x03007f00);
      expect(cpu.getBankedSP(MODE_IRQ)).toBe(0x03007008);
    });

    it.each([
      ['stmia r1!, {r0, r1}', 0xe8a10003, BASE + 4, BASE + 8],
      ['stmdb r1!, {r0, r1}', 0xe9210003, BASE - 4, BASE - 8],
      ['stmia r1!, {r1, r2} (base first)', 0xe8a10006, BASE, BASE],
    ])('%s stores the new base unless the base is the first entry', (_name, instr, slot, stored) => {
      const { cpu, mem } = setupArmCpu([instr, armBx(LR)]);
      cpu.registers[1] = BASE;
      cpu.run(10);
      expect(mem.read32(slot)).toBe(stored);
    });

    it('Thumb STMIA stores the new base when the base is not first', () => {
      const { cpu, mem } = setupThumbCpu([0xc103 /* stmia r1!, {r0, r1} */, 0x4770]);
      cpu.registers[1] = BASE;
      cpu.run(10);
      expect(mem.read32(BASE + 4)).toBe(BASE + 8);
      expect(cpu.registers[1]).toBe(BASE + 8);
    });

    it('LDM with the base in the list keeps the loaded base', () => {
      const { cpu, mem } = setupArmCpu([0xe8b10003 /* ldmia r1!, {r0, r1} */, armBx(LR)]);
      cpu.registers[1] = BASE;
      mem.write32(BASE + 4, 0xabcd);
      cpu.run(10);
      expect(cpu.registers[1]).toBe(0xabcd);
    });

    it.each([
      ['stmia', 0xe8a00000, BASE, BASE + 0x40],
      ['stmib', 0xe9a00000, BASE + 4, BASE + 0x40],
      ['stmda', 0xe8200000, BASE - 0x3c, BASE - 0x40],
      ['stmdb', 0xe9200000, BASE - 0x40, BASE - 0x40],
    ])('ARM %s with an empty list stores R15 and moves the base by 0x40', (_name, instr, slot, newBase) => {
      const { cpu, mem } = setupArmCpu([instr, armBx(LR)]);
      cpu.registers[0] = BASE;
      cpu.step();
      expect(mem.read32(slot)).toBe(0x08000000 + 12);
      expect(cpu.registers[0]).toBe(newBase);
    });

    it('ARM LDM with an empty list loads R15 and moves the base by 0x40', () => {
      const { cpu, mem } = setupArmCpu([0xe8b00000 /* ldmia r0!, {} */]);
      cpu.registers[0] = BASE;
      mem.write32(BASE, 0x08000123);
      cpu.step();
      expect(cpu.registers[PC]).toBe(0x08000120);
      expect(cpu.registers[0]).toBe(BASE + 0x40);
    });

    it('Thumb PUSH {} and POP {} transfer R15 and move SP by 0x40', () => {
      const push = setupThumbCpu([0xb400]);
      push.cpu.registers[SP] = BASE;
      push.cpu.step();
      expect(push.cpu.registers[SP]).toBe(BASE - 0x40);
      expect(push.mem.read32(BASE - 0x40)).toBe(0x08000006);

      const pop = setupThumbCpu([0xbc00]);
      pop.cpu.registers[SP] = BASE;
      pop.mem.write32(BASE, 0x08000201);
      pop.cpu.step();
      expect(pop.cpu.registers[PC]).toBe(0x08000200);
      expect(pop.cpu.registers[SP]).toBe(BASE + 0x40);
    });

    it('Thumb PUSH stores below SP, lowest register lowest; POP reads them back', () => {
      const { cpu, mem } = setupThumbCpu([0xb403 /* push {r0, r1} */, 0xbc0c /* pop {r2, r3} */, 0x4770]);
      cpu.registers[SP] = BASE;
      cpu.registers[0] = 0x10;
      cpu.registers[1] = 0x11;
      cpu.step();
      expect(cpu.registers[SP]).toBe(BASE - 8);
      expect(mem.read32(BASE - 8)).toBe(0x10);
      expect(mem.read32(BASE - 4)).toBe(0x11);
      cpu.step();
      expect([cpu.registers[2], cpu.registers[3], cpu.registers[SP]]).toEqual([0x10, 0x11, BASE]);
    });
  });

  describe('PSR rules', () => {
    it('MSR in User mode writes the flags only', () => {
      const { cpu } = setupArmCpu([0xe121f000 /* msr cpsr_c, r0 */, 0xe128f000 /* msr cpsr_f, r0 */]);
      cpu.cpsr = MODE_USR;
      cpu.registers[0] = 0xf00000d3;
      cpu.step();
      expect(cpu.cpsr).toBe(MODE_USR);
      cpu.step();
      expect(cpu.cpsr >>> 0).toBe((0xf0000000 | MODE_USR) >>> 0);
    });

    it('MSR leaves the bits ARMv4T does not implement at zero', () => {
      const { cpu } = setupArmCpu([0xe12ff000 /* msr cpsr_fsxc, r0 */]);
      cpu.registers[0] = 0xffffff1f;
      cpu.step();
      expect(cpu.cpsr >>> 0).toBe(0xf000001f);
    });

    it('MOVS pc, lr in a mode without an SPSR keeps the mode and sets the flags', () => {
      const { cpu } = setupArmCpu([0xe1b0f00e /* movs pc, lr */]);
      cpu.cpsr = MODE_SYS | (1 << 30); // Z set
      cpu.registers[LR] = 0x08000100;
      cpu.step();
      expect(cpu.getMode()).toBe(MODE_SYS);
      expect(cpu.getZ()).toBe(false);
      expect(cpu.registers[PC]).toBe(0x08000100);
    });
  });

  describe('reserved encodings', () => {
    it('condition NV never executes', () => {
      const { cpu } = setupArmCpu([0xf3a00005 /* movnv r0, #5 */, armBx(LR)]);
      cpu.registers[0] = 1;
      cpu.run(10);
      expect(cpu.registers[0]).toBe(1);
    });

    it.each([
      ['Thumb 0xDE10 (B with condition AL)', 0xde10],
      ['Thumb 0xE800 (BLX suffix)', 0xe800],
    ])('%s takes the undefined instruction trap', (_name, instr) => {
      const { cpu } = setupThumbCpu([instr]);
      cpu.step();
      expect(cpu.getMode()).toBe(MODE_UND);
      expect(cpu.getT()).toBe(false);
      expect(cpu.registers[PC]).toBe(0x04);
      expect(cpu.registers[LR]).toBe(0x08000002);
    });

    it('a coprocessor instruction takes the undefined instruction trap', () => {
      const { cpu } = setupArmCpu([0xee000010 /* mcr p0, 0, r0, c0, c0, 0 */]);
      cpu.step();
      expect(cpu.getMode()).toBe(MODE_UND);
      expect(cpu.registers[PC]).toBe(0x04);
      expect(cpu.registers[LR]).toBe(0x08000004);
    });
  });

  describe('PC alignment', () => {
    it('a branch to ARM state aligns the PC to a word', () => {
      const { cpu, mem } = setupThumbCpu([0x4700 /* bx r0 */]);
      loadArmInstructions(mem, 0x08000100, [0xe1a0000f /* mov r0, pc */]);
      cpu.registers[0] = 0x08000102;
      cpu.step();
      expect(cpu.getT()).toBe(false);
      expect(cpu.registers[PC]).toBe(0x08000100);
      cpu.step();
      expect(cpu.registers[0]).toBe(0x08000108);
    });
  });

  describe('multiply carry flag', () => {
    // C after a flag-setting multiply comes from the Booth multiplier (multiply-carry.ts). The
    // long-multiply rows are hardware results from mgba-suite src/multiply-long.c (CPSR >> 28).
    it.each([
      [0xffffffff, 0xffffffff, false, true],
      [0x7fffffff, 0xffffffff, false, true],
      [0x00000000, 0x80000000, true, false],
      [0x80000000, 0x80000000, false, true],
      [0xffffffff, 0x00000001, false, false],
      [0xffffffff, 0x80000001, false, true],
      [0x80000001, 0x7fffffff, true, true],
    ])('SMULLS/UMULLS %s * %s: C = %s / %s', (rm, rs, smullC, umullC) => {
      for (const [instr, expected] of [
        [0xe0d10392 /* smulls r0, r1, r2, r3 */, smullC],
        [0xe0910392 /* umulls r0, r1, r2, r3 */, umullC],
      ] as const) {
        const { cpu } = setupArmCpu([instr]);
        cpu.registers[2] = rm;
        cpu.registers[3] = rs;
        cpu.step();
        expect(cpu.getC()).toBe(expected);
      }
    });

    it.each([
      [0x12345678, 0x80000000, true], // all four cycles: the last Booth digit is negative
      [0x12345678, 0xc0000000, false],
      [0x89abcdef, 0x00000055, true], // one cycle
      [0xdeadbeef, 0x0000beef, true],
      [0x12345678, 0x00000055, false],
    ])('MULS %s * %s: C = %s, in ARM and Thumb', (rm, rs, expected) => {
      const arm = setupArmCpu([0xe0100392 /* muls r0, r2, r3 */]);
      arm.cpu.cpsr = MODE_SYS | (expected ? 0 : 1 << 29);
      arm.cpu.registers[2] = rm;
      arm.cpu.registers[3] = rs;
      arm.cpu.step();
      expect(arm.cpu.getC()).toBe(expected);

      const thumb = setupThumbCpu([0x4348 /* muls r0, r1 (r0 = r1 * r0) */]);
      thumb.cpu.registers[1] = rm;
      thumb.cpu.registers[0] = rs;
      thumb.cpu.step();
      expect(thumb.cpu.getC()).toBe(expected);
      expect(thumb.cpu.registers[0]).toBe(Math.imul(rm, rs) >>> 0);
    });
  });
});
