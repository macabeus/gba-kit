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

/* A struct with a deterministic ARM-EABI layout (identical under GCC 2.95 and
 * modern GCC), so the type tests assert the same offsets/sizes across both DWARF
 * dialects. Keep this byte-for-byte identical to devkitarm-min/source/main.c.
 *   Inner:  x @0 (4)  y @4 (2)                                      size 8
 *   Probe:  tag @0 (1)  count @4 (4)  flags @8 (2)  name @10 (6)
 *           ptr @16 (4)  inner @20 (8: x@20 y@24)  tail @28 (4)     size 32 */
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

struct Probe g_probe; /* forces the toolchain to emit Probe's DWARF type tree */

/* A typedef of an ANONYMOUS struct — a common C idiom. The parser must resolve
 * "Pair" via the typedef to the unnamed struct. Layout: a @0 (4), b @4 (4), size 8. */
typedef struct {
    int a;
    int b;
} Pair;

Pair g_pair;

/* A tagged enum (explicit + continued values) and a typedef of an anonymous
 * enum — the parser must read both, and Mode via its typedef alias.
 *   Color: RED 0, GREEN 5, BLUE 6     Mode: OFF 0, ON 1 */
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

/* Bitfields packed LSB-first into one storage unit. Expected little-endian layout:
 *   hearts bits 0-1   (offset 0, shift 0, width 2)
 *   stars  bits 2-4   (offset 0, shift 2, width 3)
 *   cross  bits 5-11  (offset 0, shift 5, width 7)  <- crosses the byte boundary
 *   wide   bits 12-15 (offset 1, shift 4, width 4)
 *   after  plain int at offset 4 */
struct Bits {
    unsigned hearts : 2;
    unsigned stars : 3;
    unsigned cross : 7;
    unsigned wide : 4;
    int after;
};

struct Bits g_bits;

/* cv-qualified globals + a SIGNED narrow member — declaration facts that offsets
 * and sizes alone cannot carry: the volatile/const qualifiers variableShape must
 * resolve through, and each member's base-type signedness from struct() (the same
 * byte reads as -1 or as 255 depending on it).
 *   Cv: level @0 (1, signed)  gain @2 (2, unsigned)                 size 4 */
struct Cv {
    signed char level;
    volatile unsigned short gain; /* member-level volatile (the vu16-field MMIO idiom) */
};

volatile struct Cv g_cv;                /* volatile struct (an MMIO-block idiom) */
volatile unsigned short g_mmio;         /* volatile scalar (an MMIO register idiom) */
const short g_rom_table[3] = {1, 2, 3}; /* const array (a ROM-table idiom) */

int add(int a, int b) {
    return a + b;
}

int square(int n) {
    return n * n;
}

void bump(void) {
    g_counter += 1;
    g_probe.tail = g_probe.inner.x + g_counter; /* keep g_probe + its type live */
    g_pair.a = g_pair.b + g_counter;            /* keep g_pair + its type live */
    g_color = COLOR_BLUE;                        /* keep enum Color live */
    g_mode = MODE_ON;                            /* keep enum Mode live */
    g_bits.cross = g_counter;                    /* keep struct Bits + its type live */
    g_bits.after = g_counter;
    g_cv.level = (signed char) g_counter;        /* keep struct Cv + its quals live */
    g_mmio = (unsigned short) g_counter;         /* keep the volatile scalar live */
    g_probe.count = g_rom_table[g_counter & 1];  /* keep the const table live */
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

/* ---- Producer-quirk shapes (append-only; the oracle pins lines above). Each of
 * these is a spelling agbcc encodes ambiguously or wrongly enough to have caused
 * a real parser bug; producer-quirks.spec.ts pins the correct reading. */

/* A struct this CU only ever sees FORWARD-DECLARED. The definition is in util.c,
 * whose CU links AFTER this one: the by-name index must still prefer it, or this
 * decl-only DIE (DW_AT_declaration, no members) shadows the layout. */
struct FwdPay;
struct FwdPay *g_fwd_ptr;

/* agbcc encodes both of these subranges as upper_bound 0xffffffff (DW_FORM_data4
 * holding -1): the pre-C99 zero-length trailing array, and — unlike modern gcc —
 * even an initializer-SIZED array. Reading that as upper+1 = 2^32 once claimed a
 * 4 GiB member. */
struct Flex {
    int n;
    unsigned char data[0];
};
struct Flex g_flex;
const unsigned short g_init_table[][2] = {{1, 2}, {3, 4}};

/* An unsized extern array (defined in crt0.s, i.e. outside any C compilation —
 * the ldscript-placed-table idiom). agbcc emits upper_bound 0 for it, byte-equal
 * to a real [1]; DW_AT_declaration on the variable is the disambiguator. The
 * sized local definition below pins that a REAL one-element array keeps its 1. */
extern const short g_ext_table[];
short g_one_def[1];

/* Negative control for the two above: the pret forward-declared static table —
 * declared unsized, used, then sized by its initializer. agbcc patches the type
 * at the definition (upper bounds 2,1), so this must keep length 3*2 = 6. */
static const unsigned short g_fwd_sized_table[][2];

/* The GNU zero-length array as a GLOBAL: its subrange is upper_bound 0xffffffff
 * at the variable level, the encoding that once became a 2^32-element shape. */
unsigned char g_zero[0];

int poke(int i) { /* keeps every shape above live in the DWARF */
    g_one_def[0] = (short) (g_ext_table[i] + g_init_table[i & 1][0] + g_fwd_sized_table[i & 1][1]);
    g_flex.n = i;
    return g_fwd_ptr != 0 && g_zero == g_flex.data;
}

static const unsigned short g_fwd_sized_table[][2] = {{5, 6}, {7, 8}, {9, 10}};
