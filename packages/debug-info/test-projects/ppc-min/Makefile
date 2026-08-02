# Minimal big-endian PowerPC 32 build — produces both artifact shapes with DWARF (-g):
#
#   build/main.o  — a RELOCATABLE object. This is the point of this project: PowerPC
#                   uses RELA relocations, so in a .o the `.debug_*` sections carry
#                   ZEROS where string/section offsets belong and the real values sit
#                   in `.rela.<section>` addends. Parsing its DWARF at all requires
#                   applying those addends (ElfFile.sectionData).
#   build/min.elf — the same two units linked, where the relocations are already
#                   resolved: the plain big-endian read path, alongside mips-min.
#
# Uses stock Ubuntu cross packages (gcc-powerpc-linux-gnu / binutils-powerpc-linux-gnu),
# which CI installs natively. The ELF is never executed, so it links freestanding
# (no libc, no crt0).
#
# Override PREFIX=/path/to/powerpc-linux-gnu- to use a different toolchain.

PREFIX ?= powerpc-linux-gnu-
CC := $(PREFIX)gcc

# -g: DWARF debug info. -O2: realistic optimized layout (adjacent functions), so
# .debug_line carries a non-trivial program. -fno-eliminate-unused-debug-types
# keeps a DIE for every declared type, including the ones no code reads.
CFLAGS  := -g -O2 -fno-eliminate-unused-debug-types -ffreestanding -Wall
# max-page-size: the PowerPC default (64 KiB) would pad the file out to 64 KiB of
# zeros between .text and .data. The ELF is never loaded, so page size is free.
LDFLAGS := -nostdlib -Wl,-e,main -Wl,-z,max-page-size=0x1000

GEN_ORACLE := ../tools/gen-oracle.mjs

# Default: both artifacts and their test oracles.
all: build/min.elf build/oracle.json build/oracle-obj.json
.PHONY: all

build/min.elf: build/main.o build/util.o
	$(CC) $(LDFLAGS) build/main.o build/util.o -o $@

build/%.o: %.c
	@mkdir -p build
	$(CC) $(CFLAGS) -c $< -o $@

# Oracles for the parser tests: nm/addr2line reference output for each artifact.
# The .o gets its own — its symbols/PCs are section-relative, not linked addresses.
build/oracle.json: build/min.elf $(GEN_ORACLE)
	node $(GEN_ORACLE) build/min.elf $(PREFIX) > $@

build/oracle-obj.json: build/main.o $(GEN_ORACLE)
	node $(GEN_ORACLE) build/main.o $(PREFIX) > $@

clean:
	rm -rf build

.PHONY: clean
