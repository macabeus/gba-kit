---
'@gba-kit/gba-emulator': minor
'@gba-kit/debug-info': minor
'@gba-kit/gba-node': minor
---

Refuse ill-posed reads instead of answering them

The hardware bus answers every address, because the console does: it forces an
unaligned load down to an aligned one and returns open bus for undecoded space. That is
correct emulation and a bad debugger, since the number that comes back is
indistinguishable from the one you asked for.

The bus is unchanged. The analysis surface now refuses:

- `read16` / `read32` throw on a misaligned address, naming the address the hardware
  would have read instead, and on space the bus decodes to nothing.
- `read32` returns an unsigned word; it used to go negative when bit 31 was set.
- `readBytes(address, size)` is new: 1–4 bytes at any alignment, byte-assembled.
- `readMember(base, member)` / `writeMember(base, member, value)` are new: read or write
  a DWARF `MemberLocation` with bitfields decoded, correct at any alignment.
  `writeMember` throws on a read-only target rather than letting the write vanish.
- `addressToSymbol` reports `exact` — whether `st_size` covered the address, or whether
  containment was inferred from where the next symbol starts.

**Breaking:** `read16`/`read32` throw for misaligned or undecoded addresses, which they
previously answered. `readBytes` is the replacement, and the thrown message names it.
