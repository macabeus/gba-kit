---
'@gba-kit/arm-emulator': minor
---

The disassembler reads the instruction tables of [`@match-kit/isa`](https://github.com/macabeus/match-kit/tree/main/packages/isa), in place of its own 700 lines. `disassembleThumb`, `disassembleArm`, `disassembleThumbAt` and `disassembleArmAt` keep their signatures, `size`, `target` and `symbolize`.

**The text changes** to GNU as unified syntax, the spelling of a project's `.s` files:

- A PC-relative load names the address it reads: `ldr r0, 0x0800100c`, where it was `ldr r0, [pc, #0x8] ; =0x0800100c`. An `add rd, pc, #imm` is `adr r1, 0x08001008`.
- A register list names every register: `push {r4, r5, r6, r7, lr}`, where it was `push {r4-r7, lr}`.
- A small immediate is decimal and a zero offset is left out: `adds r0, r1, #1`, `ldrh r0, [r1]`.
- An encoding that is no ARMv4T instruction prints as its bytes and what it is: `.inst.n 0xDE00 @ undefined`, where it was `dw 0x…` or, for `0xDExx`, a branch.

**Four kinds of instruction were printed wrongly** and now print as the CPU runs them:

- A Thumb `ldmia` whose base register is in the list has no writeback: `ldmia r1, {r1, r2, r3}`.
- A Thumb `lsr` or `asr` by 0 shifts by 32: `lsrs r0, r1, #0x20`.
- The Thumb encodings `0xDE00`–`0xDEFF` are undefined, not a conditional branch.
- An ARM post-indexed load or store with the W bit is the user-mode form: `ldrt`, `strt`, `ldrbt`, `strbt`.
