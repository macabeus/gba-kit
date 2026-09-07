@ Minimal GBA startup: the cartridge header's branch, then copy .data from ROM to
@ RAM, clear .bss, and enter main. The emulator boots in ARM at 0x08000000 with the
@ stacks already set (SYS 0x03007f00, IRQ 0x03007fa0, SVC 0x03007fe0).
.syntax unified
.cpu arm7tdmi
.section .text.start,"ax",%progbits
.arm
.global _start
_start:
    b boot
    .space 188                  @ the rest of the cartridge header (unused by the emulator)
boot:
    ldr r0, =__data_load
    ldr r1, =__data_start
    ldr r2, =__data_end
1:  cmp r1, r2
    ldrlo r3, [r0], #4
    strlo r3, [r1], #4
    blo 1b
    ldr r1, =__bss_start
    ldr r2, =__bss_end
    mov r3, #0
2:  cmp r1, r2
    strlo r3, [r1], #4
    blo 2b
    ldr r0, =main
    bx r0                       @ interworks into Thumb or ARM main
