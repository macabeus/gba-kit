# One small game-shaped program, built three ways, so the debugger is tested on
# unoptimized and optimized DWARF in both instruction sets:
#   thumb-O0  — what a homebrew debug build looks like
#   thumb-O2  — inlined calls, location lists, register-resident locals
#   arm-O0    — ARM code paths (the CPU boots in ARM anyway; here main is ARM too)
# Each variant yields a matching .elf (DWARF 5, symbols) and .gba (objcopy binary).
#
# thumb-O0-nocfi.elf is thumb-O0 with .debug_frame removed: the shape a decomp ELF
# built with agbcc has, where the unwinder has to measure prologues instead of
# reading call-frame information. The code is untouched, so it pairs with
# thumb-O0.gba and the ROM/ELF identity check still matches.
#
# Toolchain: arm-none-eabi-gcc on PATH, or $(DEVKITARM)/bin/arm-none-eabi-gcc.
PREFIX ?= arm-none-eabi-
ifneq ($(strip $(DEVKITARM)),)
PREFIX := $(DEVKITARM)/bin/arm-none-eabi-
endif
CC := $(PREFIX)gcc
OBJCOPY := $(PREFIX)objcopy

# -fdebug-prefix-map keeps DWARF paths relative (`source/main.c`) so the committed
# ELFs do not embed a builder's home directory. No frame pointer, no unwind tables:
# the debugger must manage with .debug_frame like it will on real projects.
COMMON := -mcpu=arm7tdmi -mthumb-interwork -g -gdwarf-5 -ffreestanding -nostdlib -fno-unwind-tables \
          -fno-asynchronous-unwind-tables -fdebug-prefix-map=$(CURDIR)=. -Wall -Wextra
LDFLAGS := -Wl,-T,source/link.ld -Wl,--gc-sections
SOURCES := source/start.s source/main.c source/util.c source/util.h source/link.ld

all: build/thumb-O0.gba build/thumb-O2.gba build/arm-O0.gba build/thumb-O0-nocfi.elf
.PHONY: all clean

build/thumb-O0.elf: $(SOURCES)
	@mkdir -p build
	$(CC) $(COMMON) -mthumb -O0 $(LDFLAGS) source/start.s source/main.c source/util.c -o $@

build/thumb-O2.elf: $(SOURCES)
	@mkdir -p build
	$(CC) $(COMMON) -mthumb -O2 $(LDFLAGS) source/start.s source/main.c source/util.c -o $@

build/arm-O0.elf: $(SOURCES)
	@mkdir -p build
	$(CC) $(COMMON) -marm -O0 $(LDFLAGS) source/start.s source/main.c source/util.c -o $@

build/thumb-O0-nocfi.elf: build/thumb-O0.elf
	$(OBJCOPY) --remove-section=.debug_frame $< $@

build/%.gba: build/%.elf
	$(OBJCOPY) -O binary $< $@

clean:
	rm -rf build
