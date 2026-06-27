// Minimal devkitARM (modern GCC) GBA program, used as real-world input for the
// @gba-kit/debug-info tests. It is never run on hardware — it exists only so the
// toolchain emits a real ELF with symbols and DWARF line info to parse.
//
// Keep the functions simple and the layout stable: the tests resolve these
// symbols and assert PC -> source mapping against this file. If you change the
// shape of this file, rebuild build/min.elf (see README) and refresh oracles.

#include "util.h"

int g_counter; // a global object symbol (STT_OBJECT)

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
