---
'@gba-kit/debug-info': minor
'@gba-kit/debug-core': minor
'@gba-kit/debug-adapter': minor
---

Expressions read a typed path the way the program writes it: `gEntityInfo[arg0].xPosBg2`,
`p->pos.x`, `*p`, `(Entity *)x`.

Typing `gEntityInfo[arg0].xPosBg2` — a line copied straight out of the source
being decompiled — used to answer `only constant subscripts and .member paths are
supported`, with a hint to work the address out by hand and read it with
`u32()`. A variable index, an arrow and a dereference are now the grammar's own,
everywhere an expression is accepted: watches, hovers, the console, breakpoint
conditions, logpoint messages, data breakpoints, and writes.

A name is a name again — the tokenizer no longer swallows a whole dotted path
into one token — and `.`, `->` and `[` are operators over a value that carries
its DWARF type. One rule makes them all fall out: a subscript, an arrow and a
dereference take the operand's **word** as the base address, while `&` and `.`
take its **place**, and an array's word is its own address, as C's decay makes
it. So `a[i]`, `*a` and `a + 1` treat an array and a pointer alike, and a chain
like `a[i].b->c[j]` costs one address computation per step.

**Pointer arithmetic is scaled**, as in C and as in GDB. With a `struct Entity *e`
of 0x50 bytes, `e + 1` is 0x50 bytes on and `*(e + 1)` is exactly `e[1]`;
subtracting two pointers of one type counts elements; an array decays, so
`gEntityInfo + 1` is `&gEntityInfo[1]`. Scaling applies only to `+` and `-`, and
only where a DWARF type says pointer or array. A register, a literal, a `u32()`
or `[addr]` read and the machine values have no type at all, so `r3 + 1` and
`u32(a) + 1` mean what they always meant — and neither does `p & 3` or `p * 2`
change, which are not pointer arithmetic in C either. `[addr]` and `{addr}` keep
their byte and halfword meaning; `*` is not a synonym for them, and on a value
with no type it says so and names `u8()`, `u16()` and `u32()` instead of
guessing a width.

**A cast means what it means in C.** `(T *)x` is a pointer value — a hex address
with the pointee as its one expandable child — and `*(T *)x`, `((T *)x)->m` and
`((T *)x)[i]` are what read through it. `(T)x` is unchanged: the T at x's
address. This is a behaviour change for `(T *)x`, which used to ignore the star
and show the T at x. `*(vu16 *)0x4000006` works, and so does `&x` on a typed
value, which is now a pointer to it rather than a bare number — the same number,
shown as an address with what it points at underneath.

**Everything the new paths name is writable**, wherever a constant path was:
`gEntityInfo[i].xPosBg2 = 10`, `p->hp = 0`, and a bitfield through a pointer.

A constant index outside a sized array is still refused when the expression is
compiled. A runtime index is not bounds-checked — GDB does not check one either,
and a pointer has no count — but an unreadable address still says so at the
moment of the read.

Types are resolved once, when the expression compiles, and never reach an
evaluated closure, which carries an offset, a read width and a signedness flag
and nothing else: a breakpoint condition is address arithmetic and memory reads.
Where the root _lives_ is asked per evaluation instead, through the new
`ExprEnv.place`, because a local moves between a stack slot and a register as the
pc advances — at `-O2` a pointer parameter often never sees memory at all, and
reading one through its register is how `p->pos.x` answers there.

New, all additive: `compile` in `@gba-kit/debug-core`, which answers a value, its
type and the place it names together, with `ExprPlace`, `ExprLvalue`, `ExprBits`
and the `rootType` / `typeByName` hints; `formatBitfield` and `le32` in
`@gba-kit/debug-info`, so a bitfield reads identically in a watch and in the
variables tree. Every new member is optional, so an `ExprEnv` or `ExprHints`
written against 0.7.0 keeps compiling and keeps answering — a root the debug info
does not type still resolves as text, which is all a symbol map can offer. In
`@gba-kit/debug-adapter`, a pointer's pointee row finally carries an
`evaluateName` (`*(g_player.counterRef)`), so it can be dragged into Watch.
