---
'@gba-kit/gba-emulator': minor
'@gba-kit/debug-info': minor
'@gba-kit/gba-node': minor
---

Refuse ill-posed reads instead of answering them

The bus answers every address, as the console does: it rounds an unaligned load down
and reads undecoded space as open bus. Correct for the CPU, and indistinguishable from
the value you asked for. The bus is unchanged; the analysis surface now refuses.

- `read16` / `read32` throw on a misaligned address, naming the one the hardware would
  have read, and on space the bus decodes to nothing. `read32` is now unsigned.
- `readBytes(address, size)` — new: 1–4 bytes at any alignment, byte-assembled.
- `readMember` / `writeMember` — new: read or write a DWARF `MemberLocation` at a base
  address, for an instance no symbol names.
- `writeVariable(path, value)` — new: the write counterpart to `readVariable`.
- `addressToSymbol` reports `exact` — whether `st_size` covered the address, or whether
  containment was inferred from the next symbol's start.

**Breaking:** `read16` / `read32` throw for misaligned or undecoded addresses, which
they previously answered. `readBytes` is the replacement.
