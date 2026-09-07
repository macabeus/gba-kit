ENTRY(_start)
MEMORY {
  ROM (rx)   : ORIGIN = 0x08000000, LENGTH = 32M
  EWRAM (rwx): ORIGIN = 0x02000000, LENGTH = 256K
  IWRAM (rwx): ORIGIN = 0x03000000, LENGTH = 32K - 256
}
SECTIONS {
  .text : { KEEP(*(.text.start)) *(.text*) *(.rodata*) . = ALIGN(4); } > ROM
  .data : { __data_start = .; *(.data*) . = ALIGN(4); __data_end = .; } > IWRAM AT> ROM
  __data_load = LOADADDR(.data);
  .bss (NOLOAD) : { __bss_start = .; *(.bss*) *(COMMON) . = ALIGN(4); __bss_end = .; } > IWRAM
  /* A global placed by the linker script, the way a decomp does it: typed in C, no storage there. */
  g_linker_placed = 0x02003ff0;
}
