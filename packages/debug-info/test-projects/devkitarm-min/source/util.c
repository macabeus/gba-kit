// A second translation unit, so the linked ELF has more than one DWARF
// compilation unit (exercises the multi-CU path in the line-table parser).
#include "util.h"

__attribute__((noinline)) int triple(int n) {
    return n * 3;
}
