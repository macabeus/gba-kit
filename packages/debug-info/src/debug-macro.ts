/**
 * DWARF `.debug_macinfo` — the preprocessor's own record of what each macro was defined as.
 *
 * A compiler invoked with `-g3` records every `#define` it saw. That is the only place some
 * facts survive at all: a macro leaves no symbol, no type and no DIE, so a consumer reading an
 * ELF has no other way to learn that a project spells a fixed address `gCounter` rather than
 * `(*(u16 *)0x03001234)`.
 *
 * This parses the DWARF 2/3 form (`.debug_macinfo`, section 6.3), which is a flat opcode stream
 * carrying its strings INLINE. The DWARF 5 replacement (`.debug_macro`) is deliberately not read
 * here: it splits a translation unit's macros across COMDAT group sections joined by
 * `DW_MACRO_import` and refers to `.debug_str` for every name, so neither survives being lifted
 * out of one object — whereas this form is self-contained by construction.
 */
import { Cursor } from './reader.js';

const DW_MACINFO_define = 0x01;
const DW_MACINFO_undef = 0x02;
const DW_MACINFO_start_file = 0x03;
const DW_MACINFO_end_file = 0x04;
const DW_MACINFO_vendor_ext = 0xff;

/** One recorded `#define`, split at the first space exactly as DWARF stores it. */
export interface MacroDefinition {
  /**
   * The defined name. For a function-like macro this includes the parameter list as written
   * (`MAX(a,b)`), because that is what DWARF records and splitting it further would invent a
   * structure the section does not have.
   */
  name: string;
  /** The replacement text, verbatim. Empty for `#define FOO` with no body. */
  body: string;
  /** Source line of the definition, as recorded. */
  line: number;
}

/**
 * Parse `.debug_macinfo` into the definitions it records, in stream order.
 *
 * Undefines, file boundaries and vendor extensions are consumed but not reported: the question
 * this answers is "what text did this name expand to", and a consumer that needs scoping would
 * need the file table too, which lives elsewhere. A truncated or malformed stream STOPS rather
 * than throwing — a partial macro list is still sound (every entry in it was really read), and
 * these sections are grafted between tools often enough that a hard failure would be the wrong
 * default for data that is purely additive.
 */
export function parseDebugMacinfo(data: Uint8Array): MacroDefinition[] {
  const out: MacroDefinition[] = [];
  // The opcode stream is bytes, ULEBs and inline strings, so byte order never applies here.
  const cur = new Cursor(data);
  while (cur.remaining > 0) {
    const opcode = cur.u8();
    if (opcode === 0) {
      // end of this compilation unit's list; another may follow immediately
      continue;
    }
    switch (opcode) {
      case DW_MACINFO_define:
      case DW_MACINFO_undef: {
        if (cur.remaining <= 0) {
          return out; // truncated
        }
        const line = cur.uleb();
        if (data.indexOf(0, cur.offset) === -1) {
          // The string's NUL never arrives: a stream cut mid-define. Reporting the bytes we do
          // have would surface a corrupted name/body as a real one — stop instead.
          return out;
        }
        const text = cur.cstr();
        if (opcode === DW_MACINFO_define) {
          const sp = text.indexOf(' ');
          out.push(
            sp === -1 ? { name: text, body: '', line } : { name: text.slice(0, sp), body: text.slice(sp + 1), line },
          );
        }
        break;
      }
      case DW_MACINFO_start_file:
        cur.uleb(); // line
        cur.uleb(); // file index
        break;
      case DW_MACINFO_end_file:
        break;
      case DW_MACINFO_vendor_ext:
        if (cur.remaining <= 0) {
          return out;
        }
        cur.uleb(); // constant
        if (data.indexOf(0, cur.offset) === -1) {
          return out; // truncated mid-string, same as a define
        }
        cur.cstr();
        break;
      default:
        // An unrecognized opcode has no length encoding, so the stream cannot be resynchronized.
        return out;
    }
  }
  return out;
}
