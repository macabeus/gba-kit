// Minimal devkitARM (modern GCC) GBA program, used as real-world input for the
// @gba-kit/debug-info tests. It is never run on hardware — it exists only so the
// toolchain emits a real ELF with symbols and DWARF line info to parse.
//
// Keep the functions simple and the layout stable: the tests resolve these
// symbols and assert PC -> source mapping against this file. If you change the
// shape of this file, rebuild build/min.elf (see README) and refresh oracles.

#include "util.h"

int g_counter; // a global object symbol (STT_OBJECT)

// A struct with a deterministic ARM-EABI layout (identical under GCC 2.95 and
// modern GCC), so the type tests assert the same offsets/sizes across both DWARF
// dialects. Keep this byte-for-byte identical to agbcc-min/main.c.
//   Inner:  x @0 (4)  y @4 (2)                                      size 8
//   Probe:  tag @0 (1)  count @4 (4)  flags @8 (2)  name @10 (6)
//           ptr @16 (4)  inner @20 (8: x@20 y@24)  tail @28 (4)     size 32
struct Inner {
    int x;
    short y;
};

struct Probe {
    char tag;
    int count;
    short flags;
    char name[6];
    int *ptr;
    struct Inner inner;
    int tail;
};

struct Probe g_probe; // forces the toolchain to emit Probe's DWARF type tree

// A typedef of an ANONYMOUS struct — a common C idiom. The parser must resolve
// "Pair" via the typedef to the unnamed struct. Layout: a @0 (4), b @4 (4), size 8.
typedef struct {
    int a;
    int b;
} Pair;

Pair g_pair;

// A tagged enum (explicit + continued values) and a typedef of an anonymous
// enum — the parser must read both, and Mode via its typedef alias.
//   Color: RED 0, GREEN 5, BLUE 6     Mode: OFF 0, ON 1
enum Color {
    COLOR_RED,
    COLOR_GREEN = 5,
    COLOR_BLUE
};

typedef enum {
    MODE_OFF,
    MODE_ON
} Mode;

enum Color g_color;
Mode g_mode;

// Bitfields packed LSB-first into one storage unit. Expected little-endian layout:
//   hearts bits 0-1   (offset 0, shift 0, width 2)
//   stars  bits 2-4   (offset 0, shift 2, width 3)
//   cross  bits 5-11  (offset 0, shift 5, width 7)  <- crosses the byte boundary
//   wide   bits 12-15 (offset 1, shift 4, width 4)
//   after  plain int at offset 4
struct Bits {
    unsigned hearts : 2;
    unsigned stars : 3;
    unsigned cross : 7;
    unsigned wide : 4;
    int after;
};

struct Bits g_bits;

// noinline keeps these as real, separately-addressed functions under -O2 so the
// tests can resolve each symbol and its PC -> source line.
__attribute__((noinline)) int add(int a, int b) {
    return a + b;
}

__attribute__((noinline)) int square(int n) {
    return n * n;
}

__attribute__((noinline)) void bump(void) {
    g_counter += 1;
    g_probe.tail = g_probe.inner.x + g_counter; // keep g_probe + its type live
    g_pair.a = g_pair.b + g_counter;            // keep g_pair + its type live
    g_color = COLOR_BLUE;                        // keep enum Color live
    g_mode = MODE_ON;                            // keep enum Mode live
    g_bits.cross = g_counter;                    // keep struct Bits + its type live
    g_bits.after = g_counter;
}

int main(void) {
    int acc = 0;
    while (1) {
        acc = add(acc, 1);
        acc = square(acc);
        acc = triple(acc); // defined in util.c -> a second compilation unit
        bump();
    }
    return acc;
}
