/* Minimal agbcc (GCC 2.95) GBA program, used as real-world input for the
 * @gba-kit/debug-info tests. It is never run on hardware — it exists only so the
 * toolchain emits a real ELF with symbols and DWARF-2 info to parse.
 *
 * No #includes: agbcc compiles this standalone. GCC 2.95 does not auto-inline
 * non-`inline` functions at -O2, so add/square/bump stay separately addressed.
 * If you change this file's shape, rebuild build/min.elf (see README) and
 * refresh the test oracles. */

int triple(int n); /* defined in util.c -> a second compilation unit */

int g_counter; /* global object symbol (lands in .bss / IWRAM) */

int add(int a, int b) {
    return a + b;
}

int square(int n) {
    return n * n;
}

void bump(void) {
    g_counter += 1;
}

int main(void) {
    int acc = 0;
    while (1) {
        acc = add(acc, 1);
        acc = square(acc);
        acc = triple(acc);
        bump();
    }
    return acc;
}
