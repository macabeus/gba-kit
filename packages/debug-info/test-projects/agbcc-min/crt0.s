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

@ Data defined OUTSIDE C, mirroring a decomp's ldscript/asm-placed table: main.c
@ declares `extern const short g_ext_table[];` and only this assembly defines it.
@ Its DWARF is therefore a DECLARATION with no knowable bound (see main.c).
	.section .rodata
	.global g_ext_table
	.align 1
g_ext_table:
	.hword 10, 20, 30, 40

@ The same idiom with a RANK: main.c declares `extern const short g_ext_grid[][4];`,
@ so only the inner extent is knowable from the DWARF.
	.global g_ext_grid
	.align 1
g_ext_grid:
	.hword 1, 2, 3, 4
	.hword 5, 6, 7, 8
