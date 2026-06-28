# Minimal agbcc (GCC 2.95) GBA build — produces build/min.elf with DWARF-2 (-g).
# Mirrors a classic GBA decomp toolchain (agbcc compiles C -> Thumb asm, then
# arm-none-eabi binutils assemble + link), trimmed to one translation unit.
#
# agbcc is a git submodule (./agbcc). Build it once with ./setup.sh, then `make`.
# Override AGBCC=/path/to/agbcc to use a prebuilt compiler.

# arm-none-eabi binutils prefix (any recent toolchain works for as/ld).
PREFIX ?= arm-none-eabi-
AS      := $(PREFIX)as
LD      := $(PREFIX)ld
CPP     := $(PREFIX)cpp

# agbcc/build.sh drops the compiler binary at the submodule root (agbcc/agbcc).
AGBCC   ?= agbcc/agbcc

CPPFLAGS := -nostdinc
# -g: DWARF-2. -O2: agbcc won't auto-inline the non-inline helpers, so they stay
# as separate functions for the tests to resolve.
CC1FLAGS := -mthumb-interwork -O2 -g
ASFLAGS  := -mcpu=arm7tdmi -mthumb-interwork

GEN_ORACLE := ../tools/gen-oracle.mjs

# Default: build the ELF and its test oracle (build/oracle.json) together.
all: build/min.elf build/oracle.json
.PHONY: all

build/min.elf: build/main.o build/util.o build/crt0.o min.ld
	$(LD) -T min.ld build/crt0.o build/main.o build/util.o -o $@

# Oracle for the parser tests: nm/addr2line reference output for this exact ELF.
build/oracle.json: build/min.elf $(GEN_ORACLE)
	node $(GEN_ORACLE) build/min.elf $(PREFIX) > $@

# Pattern rule: C -> preprocessed .i -> agbcc Thumb .s -> assembled .o
build/%.o: %.c
	@mkdir -p build
	$(CPP) $(CPPFLAGS) $< -o build/$*.i
	$(AGBCC) $(CC1FLAGS) -o build/$*.s build/$*.i
	@printf '\n\t.text\n\t.align\t2, 0\n' >> build/$*.s
	$(AS) $(ASFLAGS) -o $@ build/$*.s

build/crt0.o: crt0.s
	@mkdir -p build
	$(AS) $(ASFLAGS) -o $@ crt0.s

clean:
	rm -rf build

.PHONY: clean
