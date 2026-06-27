/* A second translation unit, so the linked ELF has more than one DWARF
 * compilation unit (exercises the multi-CU path in the line-table parser). */
int triple(int n) {
    return n * 3;
}
