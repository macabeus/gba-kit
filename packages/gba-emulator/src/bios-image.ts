/**
 * GBA HLE BIOS — the ARM code the BIOS region holds
 *
 * The emulator ships no BIOS dump. Most BIOS functions run in TypeScript at the SWI instruction
 * (bios.ts). The ones that steer the CPU itself run as ARM code from this image, entered through
 * the SWI exception the way the real BIOS's are: Halt, Stop and CustomHalt write HALTCNT from the
 * BIOS, IntrWait sleeps and takes interrupts inside its own loop, and SoftReset sets the stacks and
 * modes and jumps to the game. The image also holds the loops the real BIOS never leaves on some
 * inputs, which bios.ts hands those calls to. The IRQ vector leads to the handler that calls the
 * game's own.
 *
 * Each word is listed with the instruction it encodes. The layout follows mGBA's replacement BIOS
 * (src/gba/hle-bios.s); the code reproduces the real BIOS's behaviour, checked against it: IntrWait
 * clears only the flags it waited for, and SoftReset leaves SYS mode, CPSR 0x1F, the three boot
 * stacks and r0-r12 zero (GBATEK "BIOS Halt Functions", "BIOS Reset Functions").
 */
import { BIOS_IRQ_STUB_PUSH, BIOS_LATCH_AFTER_BOOT, BIOS_LATCH_AFTER_IRQ, BIOS_LATCH_AFTER_SWI } from './types.js';

const BIOS_SIZE = 0x4000;

// ─── Routine addresses ────────────────────────────────────────────

const SWI_DISPATCH = 0xa0;
const HALT = 0xf4;
const CUSTOM_HALT = 0xf8;
const STOP = 0x104;
const VBLANK_INTR_WAIT = 0x10c;
const INTR_WAIT = 0x114;
const SOFT_RESET = 0x160;
const NOP_CALL = 0x204;
const SWI_TABLE = 0x208;
const BIT_UNPACK_ENDLESS = 0x2a8;
const HUFF_UNCOMP_ENDLESS = 0x2e4;

/** The SWIs this image runs, by number. Every other number runs in bios.ts at the SWI instruction. */
const ROUTINES: ReadonlyMap<number, number> = new Map([
  [0x00, SOFT_RESET],
  [0x02, HALT],
  [0x03, STOP],
  [0x04, INTR_WAIT],
  [0x05, VBLANK_INTR_WAIT],
  [0x27, CUSTOM_HALT],
]);

/**
 * The loops the real BIOS never leaves on some inputs, by SWI number. bios.ts runs these SWIs and
 * hands such a call to the BIOS code, so the machine runs on as it does on hardware: interrupts are
 * taken, frames end, and a debugger can stop it.
 */
const ENDLESS_ROUTINES: ReadonlyMap<number, number> = new Map([
  [0x10, BIT_UNPACK_ENDLESS],
  [0x13, HUFF_UNCOMP_ENDLESS],
]);

/** The dispatcher's table covers SWI 0x00 up to the last number the image runs. */
const SWI_TABLE_ENTRIES = Math.max(...ROUTINES.keys()) + 1;

/** Whether SWI `swiNumber` runs as ARM code from this image, entered through the SWI exception. */
export function runsInBiosCode(swiNumber: number): boolean {
  return ROUTINES.has(swiNumber);
}

// ─── The SWI handler's frames, for a debugger ─────────────────────

/** Where swi_dispatch's `stmfd sp!, {r2, lr}` leaves the caller's r2 and lr: 8 and 4 bytes below its sp. */
const DISPATCH_SLOTS = [
  [2, 8],
  [14, 4],
] as const;
/** intr_wait's `stmfd sp!, {r4, lr}` below that: r4 16 bytes below the caller's sp. */
const INTR_WAIT_SLOTS = [...DISPATCH_SLOTS, [4, 16]] as const;

/** [first address, end address, bytes pushed on the caller's stack, where the caller's registers sit]. */
const CALLER_STACK_FRAMES: ReadonlyArray<
  readonly [from: number, to: number, pushed: number, slots: ReadonlyArray<readonly [number, number]>]
> = [
  [0xc4, 0xc8, 0, []], // SYS mode, before the push
  [0xc8, 0xd4, 8, DISPATCH_SLOTS], // the routine runs, and returns to the pop
  [0xd4, 0xdc, 0, []], // popped, still in SYS mode
  [HALT, INTR_WAIT + 4, 8, DISPATCH_SLOTS], // halt, custom_halt, stop, vblank_intr_wait, intr_wait's push
  [INTR_WAIT + 4, INTR_WAIT + 0x2c, 16, INTR_WAIT_SLOTS], // intr_wait up to its pop
  [INTR_WAIT + 0x2c, INTR_WAIT + 0x30, 8, DISPATCH_SLOTS], // its return
  [INTR_WAIT + 0x30, SOFT_RESET, 16, INTR_WAIT_SLOTS], // take_flags, called from intr_wait
  [NOP_CALL, NOP_CALL + 4, 8, DISPATCH_SLOTS],
  [BIT_UNPACK_ENDLESS, HUFF_UNCOMP_ENDLESS + 4, 8, DISPATCH_SLOTS],
];

/**
 * The SWI handler as a stack walk reads it (debug-info's ServiceCallPolicy). swi_dispatch pushes
 * r11, r12, lr and then the SPSR on the SVC stack, so the SVC stack pointer points at the SPSR, r11,
 * r12 and the return address; the routines then run in SYS mode on the caller's stack. The
 * addresses it runs in SVC mode, and SoftReset, which never returns, have no frame here.
 */
export const BIOS_SWI_HANDLER = {
  mode: 0x13, // SVC
  returnOffset: 12,
  statusOffset: 0,
  blockSlots: [
    [11, 4],
    [12, 8],
  ],
  frameAt(pc: number): { pushed: number; slots: ReadonlyArray<readonly [number, number]> } | undefined {
    const frame = CALLER_STACK_FRAMES.find(([from, to]) => pc >= from && pc < to);
    return frame && { pushed: frame[2], slots: frame[3] };
  },
} as const;

// ─── Code ─────────────────────────────────────────────────────────

/** Each section: its address and its words. */
const SECTIONS: ReadonlyArray<readonly [address: number, words: readonly number[]]> = [
  [
    0x04,
    [
      0xe1b0f00e, // 04: movs pc, lr                    undefined instruction: return past it
      0xea000024, // 08: b swi_dispatch                 SWI vector
    ],
  ],
  [
    0x18,
    [
      0xea000018, // 18: b irq_handler                  IRQ vector
    ],
  ],
  [
    // irq_handler: call the game's handler from [0x03FFFFFC], the mirror of 0x03007FFC. The game's
    // handler acknowledges IF and sets the IntrWait flags at 0x03007FF8 itself.
    0x80,
    [
      BIOS_IRQ_STUB_PUSH, // 80: stmfd sp!, {r0-r3, r12, lr}
      0xe3a00301, // 84: mov r0, #0x04000000
      0xe28fe000, // 88: add lr, pc, #0                 lr = 0x90
      0xe510f004, // 8c: ldr pc, [r0, #-4]
      0xe8bd500f, // 90: ldmfd sp!, {r0-r3, r12, lr}
      0xe25ef004, // 94: subs pc, lr, #4
      // Fetched while 0x94 executes, so the BIOS read-protection latch holds it after an IRQ, as it
      // holds the real BIOS's [0x13C+8]. During the game's handler it holds the SUBS, fetched while
      // the LDR PC at 0x8C executes: the real BIOS's [0x134+8].
      0x00000000, // 98
      BIOS_LATCH_AFTER_IRQ, // 9c
    ],
  ],
  [
    // swi_dispatch: entered in SVC mode. It looks up the routine by the SWI's comment byte, runs it
    // in SYS mode with IRQs as the caller had them, and returns with the caller's CPSR.
    SWI_DISPATCH,
    [
      0xe92d5800, // a0: stmfd sp!, {r11, r12, lr}
      0xe55ec002, // a4: ldrb r12, [lr, #-2]            the number: Thumb swi nn, or ARM swi nn0000
      0xe28fbf56, // a8: add r11, pc, #0x158            r11 = swi_table
      0xe79bc10c, // ac: ldr r12, [r11, r12, lsl #2]
      0xe14fb000, // b0: mrs r11, spsr
      0xe92d0800, // b4: stmfd sp!, {r11}
      0xe20bb080, // b8: and r11, r11, #0x80
      0xe38bb01f, // bc: orr r11, r11, #0x1f
      0xe129f00b, // c0: msr cpsr_fc, r11               SYS mode, the caller's I bit
      0xe92d4004, // c4: stmfd sp!, {r2, lr}
      0xe1a0e00f, // c8: mov lr, pc
      0xe12fff1c, // cc: bx r12
      0xe8bd4004, // d0: ldmfd sp!, {r2, lr}
      0xe3a0c0d3, // d4: mov r12, #0xd3
      0xe129f00c, // d8: msr cpsr_fc, r12               back to SVC mode, IRQs off
      0xe8bd0800, // dc: ldmfd sp!, {r11}
      0xe169f00b, // e0: msr spsr_fc, r11
      0xe8bd5800, // e4: ldmfd sp!, {r11, r12, lr}
      0xe1b0f00e, // e8: movs pc, lr
      // Fetched while the return executes: the latch every SWI leaves, the real BIOS's [0x188+8].
      0x00000000, // ec
      BIOS_LATCH_AFTER_SWI, // f0
    ],
  ],
  [
    // halt (0x02), custom_halt (0x27: r2 is the HALTCNT byte), stop (0x03)
    HALT,
    [
      0xe3a02000, // f4: mov r2, #0
      0xe3a0c301, // f8: mov r12, #0x04000000
      0xe5cc2301, // fc: strb r2, [r12, #0x301]
      0xe12fff1e, // 100: bx lr
      0xe3a02080, // 104: mov r2, #0x80
      0xeafffffa, // 108: b custom_halt
    ],
  ],
  [
    // vblank_intr_wait (0x05) is IntrWait(1, VBlank). intr_wait (0x04): with r0 set, first drop the
    // flags already waiting; then halt until the game's handler has set one of the r1 flags at
    // 0x03007FF8, and clear those. IME is 1 from the first check on.
    VBLANK_INTR_WAIT,
    [
      0xe3a00001, // 10c: mov r0, #1
      0xe3a01001, // 110: mov r1, #1
      0xe92d4010, // 114: stmfd sp!, {r4, lr}
      0xe3a03000, // 118: mov r3, #0
      0xe3a04001, // 11c: mov r4, #1
      0xe3a0c301, // 120: mov r12, #0x04000000
      0xe3500000, // 124: cmp r0, #0
      0x0a000001, // 128: beq 0x134
      0xeb000004, // 12c: bl take_flags                 discard the flags already set
      0xe5cc3301, // 130: strb r3, [r12, #0x301]        halt
      0xeb000002, // 134: bl take_flags
      0x0afffffc, // 138: beq 0x130
      0xe8bd4010, // 13c: ldmfd sp!, {r4, lr}
      0xe12fff1e, // 140: bx lr
      // take_flags: r0 = the waited flags set at 0x03FFFFF8 (0x03007FF8), cleared there; Z when none.
      0xe5cc3208, // 144: strb r3, [r12, #0x208]        IME = 0
      0xe15c20b8, // 148: ldrh r2, [r12, #-8]
      0xe0110002, // 14c: ands r0, r1, r2
      0x10222000, // 150: eorne r2, r2, r0
      0x114c20b8, // 154: strhne r2, [r12, #-8]
      0xe5cc4208, // 158: strb r4, [r12, #0x208]        IME = 1
      0xe12fff1e, // 15c: bx lr
    ],
  ],
  [
    // soft_reset (0x00): clear 0x03007E00-0x03007FFF, set the IRQ, SVC and SYS stacks with LR and
    // SPSR zero, and jump to 0x08000000, or to 0x02000000 when the byte at 0x03007FFA is non-zero,
    // in SYS mode with r0-r12 zero.
    SOFT_RESET,
    [
      0xe321f0df, // 160: msr cpsr_c, #0xdf             IRQs off while the vector area clears
      0xe3a0c301, // 164: mov r12, #0x04000000
      0xe55c2006, // 168: ldrb r2, [r12, #-6]           [0x03007FFA]
      0xe24c1c02, // 16c: sub r1, r12, #0x200
      0xe3a00000, // 170: mov r0, #0
      0xe4810004, // 174: str r0, [r1], #4
      0xe151000c, // 178: cmp r1, r12
      0x3afffffc, // 17c: blo 0x174
      0xe3520000, // 180: cmp r2, #0
      0x03a02302, // 184: moveq r2, #0x08000000
      0x13a02402, // 188: movne r2, #0x02000000
      0xe321f0d2, // 18c: msr cpsr_c, #0xd2             IRQ mode
      0xe59fd060, // 190: ldr sp, =0x03007fa0
      0xe3a0e000, // 194: mov lr, #0
      0xe169f000, // 198: msr spsr_fc, r0
      0xe321f0d3, // 19c: msr cpsr_c, #0xd3             SVC mode
      0xe59fd054, // 1a0: ldr sp, =0x03007fe0
      0xe3a0e000, // 1a4: mov lr, #0
      0xe169f000, // 1a8: msr spsr_fc, r0
      0xe3a0101f, // 1ac: mov r1, #0x1f
      0xe129f001, // 1b0: msr cpsr_fc, r1               SYS mode, IRQs on, flags clear
      0xe59fd044, // 1b4: ldr sp, =0x03007f00
      0xe1a0e002, // 1b8: mov lr, r2
      0xe3a01000, // 1bc: mov r1, #0
      0xe3a02000, // 1c0: mov r2, #0
      0xe3a03000, // 1c4: mov r3, #0
      0xe3a04000, // 1c8: mov r4, #0
      0xe3a05000, // 1cc: mov r5, #0
      0xe3a06000, // 1d0: mov r6, #0
      0xe3a07000, // 1d4: mov r7, #0
      0xe3a08000, // 1d8: mov r8, #0
      0xe3a09000, // 1dc: mov r9, #0
      0xe3a0a000, // 1e0: mov r10, #0
      0xe3a0b000, // 1e4: mov r11, #0
      0xe3a0c000, // 1e8: mov r12, #0
      0xe12fff1e, // 1ec: bx lr
      // Fetched while the jump executes: the latch the boot leaves, the real BIOS's [0xDC+8].
      0x00000000, // 1f0
      BIOS_LATCH_AFTER_BOOT, // 1f4
      0x03007fa0, // 1f8: the IRQ stack
      0x03007fe0, // 1fc: the SVC stack
      0x03007f00, // 200: the SYS stack
    ],
  ],
  [
    NOP_CALL,
    [
      0xe12fff1e, // 204: bx lr
    ],
  ],
  [
    SWI_TABLE,
    Array.from({ length: SWI_TABLE_ENTRIES }, (_, n) => ROUTINES.get(n) ?? ENDLESS_ROUTINES.get(n) ?? NOP_CALL),
  ],
  [
    // bit_unpack_endless (0x10 with a source width of 0): the real BIOS's unit loop never reaches the
    // next source byte. Each unit is 0, or the offset when bit 31 adds it to zero units too; a word
    // of them is stored past the destination each time the units reach 32 bits, forever.
    BIT_UNPACK_ENDLESS,
    [
      0xe592c004, // 2a8: ldr r12, [r2, #4]             data offset
      0xe5d22003, // 2ac: ldrb r2, [r2, #3]             destination width
      0xe2800001, // 2b0: add r0, r0, #1                the source byte it read
      0xe1b0c08c, // 2b4: movs r12, r12, lsl #1         C = bit 31
      0xe1a0c0ac, // 2b8: mov r12, r12, lsr #1          the offset
      0x33a0c000, // 2bc: movcc r12, #0                 zero units stay 0
      0xe3a03000, // 2c0: mov r3, #0                    bits filled
      0xe3a0e000, // 2c4: mov lr, #0                    the word
      0xe18ee31c, // 2c8: orr lr, lr, r12, lsl r3
      0xe0833002, // 2cc: add r3, r3, r2
      0xe3530020, // 2d0: cmp r3, #32
      0xa481e004, // 2d4: strge lr, [r1], #4
      0xa3a0e000, // 2d8: movge lr, #0
      0xa3a03000, // 2dc: movge r3, #0
      0xeafffff8, // 2e0: b 0x2c8
      // huff_uncomp_endless (0x13 whose tree walk finds no leaf): the walk reads on through memory
      // and stores nothing.
      0xeafffffe, // 2e4: b .
    ],
  ],
];

/** The 16 KB BIOS region as this image fills it; the rest reads zero. */
export function buildBiosImage(): Uint8Array {
  const image = new Uint8Array(BIOS_SIZE);
  const view = new DataView(image.buffer);
  for (const [address, words] of SECTIONS) {
    words.forEach((word, i) => view.setUint32(address + i * 4, word >>> 0, true));
  }
  return image;
}
