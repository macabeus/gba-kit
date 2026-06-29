/* Minimal GBA layout: code in ROM at 0x08000000, zero-init data in IWRAM.
 * Mirrors how real GBA projects place .text/.bss; enough for the ELF to carry
 * correct VMAs for symbols and DWARF. */
ENTRY(_start)

/* A linker-defined absolute global, as GBA decomps use to place a struct at a
 * fixed RAM address. Emitted STT_NOTYPE / STB_GLOBAL / SHN_ABS — exercises
 * symbolToAddress resolving ldscript symbols. */
gAbsGlobal = 0x03001234;

MEMORY {
    rom   (rx)  : ORIGIN = 0x08000000, LENGTH = 32M
    iwram (rwx) : ORIGIN = 0x03000000, LENGTH = 32K
}

SECTIONS {
    .text 0x08000000 : {
        KEEP(*(.text._start))
        *(.text*)
    } > rom

    .rodata : { *(.rodata*) } > rom

    .bss (NOLOAD) : { *(.bss*) *(COMMON) } > iwram

    /DISCARD/ : { *(.comment) *(.note*) *(.ARM.attributes) }
}
