@ Minimal entry stub. This ELF is only parsed for symbols/DWARF, never run, so
@ no valid GBA cartridge header is needed — just an _start that references main
@ and lands first in .text.
	.syntax unified
	.section .text._start, "ax", %progbits
	.global _start
	.thumb
	.thumb_func
_start:
	bl main
.L_hang:
	b .L_hang

@ GCC 2.95 emits a call to __gccmain at the top of main() (static-init hook).
@ Provide an empty stub so the link resolves.
	.global __gccmain
	.thumb_func
__gccmain:
	bx lr
