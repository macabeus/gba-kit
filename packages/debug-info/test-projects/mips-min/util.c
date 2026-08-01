/* A second translation unit, so the linked ELF has more than one DWARF
 * compilation unit — the multi-CU path (per-CU abbrev tables, one .debug_line
 * sequence per CU) read out of a big-endian payload.
 *
 * Keep this byte-for-byte identical to the sibling big-endian project's util.c. */

struct UtilPair {
    short lo;
    short hi;
};

struct UtilPair g_util_pair;

int triple(int n) {
    g_util_pair.lo = (short) n;
    return n * 3;
}
