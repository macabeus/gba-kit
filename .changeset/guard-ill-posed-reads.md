---
'@gba-kit/gba-emulator': minor
'@gba-kit/debug-info': minor
'@gba-kit/gba-node': minor
---

Refuse ill-posed reads instead of answering them

The hardware bus answers every address, because the console does: it forces an
unaligned load down to an aligned one and returns open bus for unmapped space. That is
correct emulation and a bad debugger — the number that comes back is indistinguishable
from the one you asked for. It has produced at least one confidently wrong reading of a
struct field in a real decomp, where a `u8[2]` member at offset 3 of a struct was read
through `bus.read16` and silently returned the two bytes at offset 2.

The hardware bus is unchanged. The **analysis-facing** surface now refuses:

- `read16` / `read32` throw on a misaligned address, naming the address the hardware
  would have read instead, and throw on address space nothing backs (including a
  pointer past the end of the loaded cartridge, which used to read as `0`).
- `read32` is now **unsigned**. The bus assembles words with `|`, an int32 operator, so
  a word with bit 31 set came back negative — 19% of a typical ROM, including Klonoa's
  first word, whose `0xEA00002E` formatted as `"-15ffffd2"`.
- **`readBytes(address, size)`** is new: 1–4 bytes at _any_ alignment, byte-assembled,
  so there is a right way to read the values aligned loads cannot address.
- **`readMember(base, member)` / `writeMember(base, member, value)`** are new: read or
  write a DWARF `MemberLocation` with bitfields decoded, correct at any alignment.
  `writeMember` throws on a read-only target rather than letting the write vanish.
- `addressToSymbol` now reports **`exact`** — whether the symbol's own `st_size`
  covered the address, or whether the containment was inferred from where the next
  symbol starts. This is not a detail: in a decomp ELF most symbols come from
  hand-written asm and declare no size (827 of 1162 functions in Klonoa), so a lookup
  landing 3 KB past a function's real body still resolved to it with nothing to say the
  containment was never established.

`read16`/`read32` throwing is a breaking change for scripts that were reading
misaligned or unmapped addresses — which is the point, since those reads were returning
a value for a question they had not asked. `readBytes` is the replacement.
