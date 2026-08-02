# Minimal big-endian MIPS build — produces build/min.elf with DWARF (-g).
# Mirrors an N64-style target: 32-bit MIPS o32, ELFDATA2MSB, so both the ELF
# container AND its DWARF payload are stored MSB-first.
#
# Uses stock Ubuntu cross packages (gcc-mips-linux-gnu / binutils-mips-linux-gnu),
# which CI installs natively. The ELF is never executed, so it links freestanding
# (no libc, no crt0) — a linker and the compiler are all that is needed.
#
# Override PREFIX=/path/to/mips-linux-gnu- to use a different toolchain.

PREFIX ?= mips-linux-gnu-
CC := $(PREFIX)gcc

# -g: DWARF debug info. -O2: realistic optimized layout (adjacent functions), so
# .debug_line carries a non-trivial program. -fno-eliminate-unused-debug-types
# keeps a DIE for every declared type, including the ones no code reads.
CFLAGS  := -g -O2 -fno-eliminate-unused-debug-types -ffreestanding -Wall
LDFLAGS := -nostdlib -Wl,-e,main

GEN_ORACLE := ../tools/gen-oracle.mjs

# Default: build the ELF and its test oracle (build/oracle.json) together.
all: build/min.elf build/oracle.json
.PHONY: all

build/min.elf: main.c util.c
	@mkdir -p build
	$(CC) $(CFLAGS) $(LDFLAGS) main.c util.c -o $@

# Oracle for the parser tests: nm/addr2line reference output for this exact ELF.
build/oracle.json: build/min.elf $(GEN_ORACLE)
	node $(GEN_ORACLE) build/min.elf $(PREFIX) > $@

clean:
	rm -rf build

.PHONY: clean
