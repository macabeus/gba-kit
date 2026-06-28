# Minimal modern-GCC GBA build — produces build/min.elf with DWARF (-g).
# Mirrors a modern homebrew toolchain (devkitARM / modern arm-none-eabi-gcc),
# trimmed to two tiny translation units with no external libraries.
#
# This ELF is only parsed for symbols + DWARF, never run on hardware, so it links
# freestanding (no devkitARM gba.specs / crt0). Any modern arm-none-eabi-gcc works
# — devkitARM or the ARM GNU Toolchain, GCC 13/14+ — which is all the parser tests
# need (a modern DWARF dialect to contrast with agbcc's DWARF-2).
#
# Toolchain selection:
#   - default: arm-none-eabi-gcc on PATH
#   - if DEVKITARM is set: use $(DEVKITARM)/bin/arm-none-eabi-gcc (CI / Docker)
#   - or override PREFIX=/path/to/arm-none-eabi-

PREFIX ?= arm-none-eabi-
ifneq ($(strip $(DEVKITARM)),)
PREFIX := $(DEVKITARM)/bin/arm-none-eabi-
endif
CC := $(PREFIX)gcc

# -g: DWARF debug info. -O2: realistic optimized layout (adjacent functions) so the
# parser is exercised on non-trivial line programs. Freestanding + place .text at
# the GBA ROM base so symbols carry GBA-like VMAs; entry is main (no crt0 linked).
CFLAGS  := -g -O2 -mthumb -mthumb-interwork -ffreestanding -Wall
# --defsym adds a linker-defined absolute global (STT_NOTYPE/STB_GLOBAL/SHN_ABS),
# mirroring how GBA decomps place a struct at a fixed RAM address via the ldscript.
LDFLAGS := -nostdlib -Wl,-Ttext=0x08000000 -Wl,-e,main -Wl,--defsym,gAbsGlobal=0x03001234

GEN_ORACLE := ../tools/gen-oracle.mjs

# Default: build the ELF and its test oracle (build/oracle.json) together.
all: build/min.elf build/oracle.json
.PHONY: all

build/min.elf: source/main.c source/util.c source/util.h
	@mkdir -p build
	$(CC) $(CFLAGS) $(LDFLAGS) source/main.c source/util.c -o $@

# Oracle for the parser tests: nm/addr2line reference output for this exact ELF.
build/oracle.json: build/min.elf $(GEN_ORACLE)
	node $(GEN_ORACLE) build/min.elf $(PREFIX) > $@

clean:
	rm -rf build

.PHONY: clean
