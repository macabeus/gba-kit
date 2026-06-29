// A second translation unit, so the linked ELF has more than one DWARF
// compilation unit (exercises the multi-CU path in the line-table parser).
//
// It also defines its own struct so the ELF has a SECOND type-bearing abbrev
// table after main.c's — a guard that each abbrev table is bounded to the next
// CU's offset (agbcc abuts tables with no 0-code terminator between them).
#include "util.h"

struct UtilPair {
    short lo;
    short hi;
};

struct UtilPair g_util_pair;

__attribute__((noinline)) int triple(int n) {
    g_util_pair.lo = (short) n;
    return n * 3;
}
