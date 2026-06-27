/* Minimal GBA layout: code in ROM at 0x08000000, zero-init data in IWRAM.
 * Mirrors how real GBA projects place .text/.bss; enough for the ELF to carry
 * correct VMAs for symbols and DWARF. */
ENTRY(_start)

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
