/* A second translation unit, so the linked ELF has more than one DWARF
 * compilation unit (exercises the multi-CU path in the line-table parser).
 *
 * It also defines its own struct so the ELF has a SECOND type-bearing abbrev
 * table after main.c's. agbcc (DWARF-2) abuts abbrev tables without a 0-code
 * terminator, so this guards that each table is bounded to the next CU's offset
 * (otherwise main.c's table would bleed into this one and corrupt both). */
struct UtilPair {
    short lo;
    short hi;
};

struct UtilPair g_util_pair;

int triple(int n) {
    g_util_pair.lo = (short) n;
    return n * 3;
}

/* The DEFINITION of the struct main.c only forward-declares (see main.c: this CU
 * links second, so a first-CU-wins index would lose this layout).
 *   FwdPay: amount @0 (4)  currency @4 (2)                           size 8 */
struct FwdPay {
    int amount;
    short currency;
};

struct FwdPay g_fwd_pay;
