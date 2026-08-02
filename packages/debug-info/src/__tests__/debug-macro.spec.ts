/**
 * `.debug_macinfo` — the macro table, against a real artifact.
 *
 * `devkitarm-min/build/macinfo.o` is that project's `main.c` compiled the way a decomp's
 * macro sidecar is (`-gdwarf-2 -g3 -gstrict-dwarf`; see the project Makefile): one
 * self-contained `.debug_macinfo` with inline strings, in a relocatable `.o` — the same
 * artifact shape a real project grafts from. The fixture macros live at the END of that
 * `main.c` and are asserted by exact line number (append there, never insert above).
 * `readelf --debug-dump=macro` agreed on every define when the artifact was added.
 *
 * The macro channel exists for one decomp idiom above all: a fixed RAM cell named by an
 * address-cast `#define` instead of an extern. Such a name is in no symbol table and has
 * no DIE — the preprocessor's record is the only place it survives.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseDebugMacinfo } from '../debug-macro.js';
import { ElfFile } from '../elf.js';

const here = dirname(fileURLToPath(import.meta.url));
const project = join(here, '..', '..', 'test-projects', 'devkitarm-min', 'build');

const elf = ElfFile.parse(new Uint8Array(readFileSync(join(project, 'macinfo.o'))));
const section = elf.sectionData('.debug_macinfo')!;
const macros = parseDebugMacinfo(section);
const byName = (name: string) => macros.find((m) => m.name === name);

describe('parseDebugMacinfo on a real -gdwarf-2 -g3 object', () => {
  it('reads the address-cast fixtures verbatim, with their lines', () => {
    expect(byName('REG_DISPSTAT')).toEqual({
      name: 'REG_DISPSTAT',
      body: '(*(volatile unsigned short *)0x04000004)',
      line: 157,
    });
    expect(byName('g_save_slot')).toEqual({
      name: 'g_save_slot',
      body: '(*(unsigned char *)0x03007FF0)',
      line: 158,
    });
    expect(byName('EWRAM_BASE')).toEqual({ name: 'EWRAM_BASE', body: '0x02000000', line: 159 });
  });

  it('keeps a function-like macro as one name, the parameter list as recorded', () => {
    // DWARF stores the define as written post-lex: params squeezed, body spacing kept.
    // Splitting "CLAMP(x,lo,hi)" further would invent structure the section lacks.
    expect(byName('CLAMP(x,lo,hi)')).toEqual({
      name: 'CLAMP(x,lo,hi)',
      body: '((x) < (lo) ? (lo) : (x) > (hi) ? (hi) : (x))',
      line: 160,
    });
  });

  it('reports a body-less define with an empty body, not a missing entry', () => {
    expect(byName('NO_BODY')).toEqual({ name: 'NO_BODY', body: '', line: 161 });
  });

  it('reports definitions in stream order', () => {
    const lines = ['REG_DISPSTAT', 'g_save_slot', 'EWRAM_BASE', 'CLAMP(x,lo,hi)', 'NO_BODY'].map((n) =>
      macros.findIndex((m) => m.name === n),
    );
    expect(lines.every((i) => i >= 0)).toBe(true);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
  });

  it('carries the compiler built-ins at line 0 alongside the user macros', () => {
    // The exact built-in set is the compiler's business (do not pin a total): assert the
    // class exists and is large, which is what makes "grep the table" a real capability.
    const builtins = macros.filter((m) => m.line === 0);
    expect(builtins.length).toBeGreaterThan(300);
    expect(byName('__VERSION__')).toBeDefined();
  });

  it('a truncated stream yields a sound prefix, never a throw', () => {
    // Sections get grafted between tools; the contract is that every returned entry was
    // really read. Cutting the stream anywhere must give a prefix of the full parse.
    for (const cut of [section.length >> 2, section.length >> 1, section.length - 3]) {
      const partial = parseDebugMacinfo(section.slice(0, cut));
      expect(partial.length).toBeLessThanOrEqual(macros.length);
      expect(partial).toEqual(macros.slice(0, partial.length));
    }
  });
});

describe('the -g3 requirement', () => {
  it('a plain -g ELF has no .debug_macinfo at all', () => {
    const plain = ElfFile.parse(new Uint8Array(readFileSync(join(project, 'min.elf'))));
    expect(plain.sectionData('.debug_macinfo')).toBeUndefined();
  });
});
