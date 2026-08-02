/* Minimal BIG-ENDIAN probe program, used as real-world input for the
 * @gba-kit/debug-info tests. It is never executed — it exists only so a
 * big-endian cross toolchain emits a real ELF whose symbol table and DWARF
 * payload (.debug_info / .debug_abbrev / .debug_str / .debug_line) are all
 * stored MSB-first, which is what the parser must read.
 *
 * Keep this byte-for-byte identical to the sibling big-endian project's main.c
 * (mips-min / ppc-min): MIPS o32 and PowerPC SysV are both 32-bit big-endian
 * with 4-byte int alignment, so every layout asserted by the tests holds for
 * both.
 *
 * Every declaration below is one shape the parser classifies. Types that are
 * only declared (never read) still get a DIE thanks to
 * -fno-eliminate-unused-debug-types.
 *
 * char signedness is deliberately never left to the default: it is signed on
 * MIPS and unsigned on PowerPC, so plain `char` would not agree across the two
 * projects. Each narrow member spells its own signedness. */

int triple(int n); /* defined in util.c -> a second compilation unit */

int g_counter;      /* scalar global (.bss) */
int *g_ptr;         /* pointer global: its target is a scalar */
short g_table[4];   /* array: element size 2, length 4, signed elements */
volatile int g_vol; /* volatile scalar (an MMIO-register idiom) */

const short g_rom_table[3] = {1, 2, 3}; /* const array (a ROM-table idiom) */

/* A struct with a deterministic layout on both 32-bit big-endian ABIs:
 *   Inner:  x @0 (4)  y @4 (2)                                      size 8
 *   Probe:  tag @0 (1)  count @4 (4)  flags @8 (2)  name @10 (6)
 *           ptr @16 (4)  inner @20 (8: x@20 y@24)  tail @28 (4)     size 32 */
struct Inner {
    int x;
    short y;
};

struct Probe {
    unsigned char tag;
    int count;
    short flags;
    unsigned char name[6];
    int *ptr;
    struct Inner inner;
    int tail;
};
struct Probe g_probe;                 /* struct global */
struct Probe *g_probe_ptr = &g_probe; /* pointer whose target is a STRUCT, not a scalar */

/* Bitfields. A big-endian target allocates them MSB-FIRST within the storage
 * unit, the mirror image of the little-endian projects' identical declaration:
 *   hearts bits 31-30 of the 4-byte unit at 0 -> byte 0, top 2 bits
 *   stars  bits 29-27                        -> byte 0
 *   cross  bits 26-20                        -> byte 0..1 (crosses the boundary)
 *   wide   bits 19-16                        -> byte 1, low 4 bits
 *   after  plain int at offset 4 */
struct Bits {
    unsigned hearts : 2;
    unsigned stars : 3;
    unsigned cross : 7;
    unsigned wide : 4;
    int after;
};

struct Bits g_bits;

/* cv-qualified declarations the parser must resolve THROUGH: a member-level
 * volatile, and a signed narrow member next to an unsigned one.
 *   Cv: level @0 (1, signed)  gain @2 (2, unsigned)                 size 4 */
struct Cv {
    signed char level;
    volatile unsigned short gain;
};

volatile struct Cv g_cv;

int add(int a, int b) {
    return a + b;
}

int square(int n) {
    return n * n;
}

/* ---- RANK. A flat element count cannot say how many subscripts reach an ELEMENT, and
 * `g[i]` on a `[2][3]` is a ROW. The per-dimension extents are their own fact
 * (variableShape().dims / StructMember.dims), and they are ABI- and byte-order-independent,
 * so all four toolchains must report them identically. (agbcc-min additionally carries the
 * `extern T x[][4]` idiom, whose unsized outer bound is a GCC 2.95 ENCODING quirk — modern
 * producers spell it differently, so it is pinned there rather than shared.) */
unsigned char g_grid3[2][3][4]; /* fully-bounded rank 3: dims [2,3,4], length 24 */

struct Grid { /*   Grid: id @0 (4)  cells @4 (12: [2][3] of u16)        size 16 */
    int id;
    unsigned short cells[2][3]; /* the same fact one level down, on a member */
};
struct Grid g_grid;

void bump(void) {
    g_counter += 1;
    g_ptr = &g_counter;                          /* keep the pointer global live */
    g_table[g_counter & 3] = (short) g_counter;  /* keep the array live */
    g_vol = g_counter;                           /* keep the volatile scalar live */
    g_probe.tail = g_probe.inner.x + g_counter;  /* keep g_probe + its type live */
    g_bits.cross = g_counter;                    /* keep struct Bits + its type live */
    g_bits.after = g_counter;
    g_cv.level = (signed char) g_counter;        /* keep struct Cv + its quals live */
    g_probe.count = g_rom_table[g_counter & 1];  /* keep the const table live */
    g_grid3[1][2][3] = (unsigned char) g_counter; /* keep the rank-3 array live */
    g_grid.cells[1][2] = (unsigned short) g_grid.id; /* keep struct Grid + its 2-D member live */
}

int main(void) {
    int acc = 0;
    acc = add(acc, 1);
    acc = square(acc);
    acc = triple(acc);
    bump();
    return acc;
}
