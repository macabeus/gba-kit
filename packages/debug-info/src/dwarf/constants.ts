/**
 * The DWARF tag, attribute, form and operation codes the scope/location readers
 * use. (`types.ts` keeps its own private set for the type index; these are the
 * public ones consumers of `DwarfEntry` may need.)
 */

export const DW_TAG = {
  array_type: 0x01,
  enumeration_type: 0x04,
  formal_parameter: 0x05,
  lexical_block: 0x0b,
  member: 0x0d,
  pointer_type: 0x0f,
  compile_unit: 0x11,
  structure_type: 0x13,
  subroutine_type: 0x15,
  typedef: 0x16,
  union_type: 0x17,
  unspecified_parameters: 0x18,
  inlined_subroutine: 0x1d,
  subrange_type: 0x21,
  base_type: 0x24,
  const_type: 0x26,
  enumerator: 0x28,
  subprogram: 0x2e,
  variable: 0x34,
  volatile_type: 0x35,
  restrict_type: 0x37,
  partial_unit: 0x3c,
} as const;

export const DW_AT = {
  location: 0x02,
  name: 0x03,
  byte_size: 0x0b,
  bit_offset: 0x0c,
  bit_size: 0x0d,
  stmt_list: 0x10,
  low_pc: 0x11,
  high_pc: 0x12,
  language: 0x13,
  const_value: 0x1c,
  upper_bound: 0x2f,
  abstract_origin: 0x31,
  artificial: 0x34,
  count: 0x37,
  data_member_location: 0x38,
  decl_file: 0x3a,
  decl_line: 0x3b,
  declaration: 0x3c,
  encoding: 0x3e,
  external: 0x3f,
  frame_base: 0x40,
  specification: 0x47,
  type: 0x49,
  entry_pc: 0x52,
  ranges: 0x55,
  call_file: 0x58,
  call_line: 0x59,
  data_bit_offset: 0x6b,
  str_offsets_base: 0x72,
  addr_base: 0x73,
  rnglists_base: 0x74,
  loclists_base: 0x8c,
} as const;

export const DW_FORM = {
  addr: 0x01,
  block2: 0x03,
  block4: 0x04,
  data2: 0x05,
  data4: 0x06,
  data8: 0x07,
  string: 0x08,
  block: 0x09,
  block1: 0x0a,
  data1: 0x0b,
  flag: 0x0c,
  sdata: 0x0d,
  strp: 0x0e,
  udata: 0x0f,
  ref_addr: 0x10,
  ref1: 0x11,
  ref2: 0x12,
  ref4: 0x13,
  ref8: 0x14,
  ref_udata: 0x15,
  indirect: 0x16,
  sec_offset: 0x17,
  exprloc: 0x18,
  flag_present: 0x19,
  strx: 0x1a,
  addrx: 0x1b,
  data16: 0x1e,
  line_strp: 0x1f,
  implicit_const: 0x21,
  loclistx: 0x22,
  rnglistx: 0x23,
  addrx1: 0x29,
  addrx2: 0x2a,
  addrx3: 0x2b,
  addrx4: 0x2c,
} as const;

/** The class of a form, which decides how an attribute's value is interpreted. */
export type FormClass =
  | 'address'
  | 'addrx'
  | 'constant'
  | 'block'
  | 'string'
  | 'flag'
  | 'reference'
  | 'secoffset'
  | 'loclistx'
  | 'rnglistx'
  | 'other';

export function formClass(form: number): FormClass {
  switch (form) {
    case DW_FORM.addr:
      return 'address';
    case DW_FORM.addrx:
    case DW_FORM.addrx1:
    case DW_FORM.addrx2:
    case DW_FORM.addrx3:
    case DW_FORM.addrx4:
      return 'addrx';
    case DW_FORM.data1:
    case DW_FORM.data2:
    case DW_FORM.data4:
    case DW_FORM.data8:
    case DW_FORM.sdata:
    case DW_FORM.udata:
    case DW_FORM.implicit_const:
      return 'constant';
    case DW_FORM.block:
    case DW_FORM.block1:
    case DW_FORM.block2:
    case DW_FORM.block4:
    case DW_FORM.exprloc:
    case DW_FORM.data16:
      return 'block';
    case DW_FORM.string:
    case DW_FORM.strp:
    case DW_FORM.line_strp:
    case DW_FORM.strx:
      return 'string';
    case DW_FORM.flag:
    case DW_FORM.flag_present:
      return 'flag';
    case DW_FORM.ref1:
    case DW_FORM.ref2:
    case DW_FORM.ref4:
    case DW_FORM.ref8:
    case DW_FORM.ref_udata:
    case DW_FORM.ref_addr:
      return 'reference';
    case DW_FORM.sec_offset:
      return 'secoffset';
    case DW_FORM.loclistx:
      return 'loclistx';
    case DW_FORM.rnglistx:
      return 'rnglistx';
    default:
      return 'other';
  }
}

export const DW_OP = {
  addr: 0x03,
  deref: 0x06,
  const1u: 0x08,
  const1s: 0x09,
  const2u: 0x0a,
  const2s: 0x0b,
  const4u: 0x0c,
  const4s: 0x0d,
  const8u: 0x0e,
  const8s: 0x0f,
  constu: 0x10,
  consts: 0x11,
  dup: 0x12,
  drop: 0x13,
  over: 0x14,
  pick: 0x15,
  swap: 0x16,
  rot: 0x17,
  abs: 0x19,
  and: 0x1a,
  div: 0x1b,
  minus: 0x1c,
  mod: 0x1d,
  mul: 0x1e,
  neg: 0x1f,
  not: 0x20,
  or: 0x21,
  plus: 0x22,
  plus_uconst: 0x23,
  shl: 0x24,
  shr: 0x25,
  shra: 0x26,
  xor: 0x27,
  bra: 0x28,
  eq: 0x29,
  ge: 0x2a,
  gt: 0x2b,
  le: 0x2c,
  lt: 0x2d,
  ne: 0x2e,
  skip: 0x2f,
  lit0: 0x30,
  lit31: 0x4f,
  reg0: 0x50,
  reg31: 0x6f,
  breg0: 0x70,
  breg31: 0x8f,
  regx: 0x90,
  fbreg: 0x91,
  bregx: 0x92,
  piece: 0x93,
  deref_size: 0x94,
  nop: 0x96,
  call_frame_cfa: 0x9c,
  bit_piece: 0x9d,
  implicit_value: 0x9e,
  stack_value: 0x9f,
  implicit_pointer: 0xa0,
  addrx: 0xa1,
  constx: 0xa2,
  entry_value: 0xa3,
  GNU_implicit_pointer: 0xf2,
  GNU_entry_value: 0xf3,
} as const;

/** DWARF base-type encodings (`DW_ATE_*`). */
export const DW_ATE = {
  boolean: 0x02,
  float: 0x04,
  signed: 0x05,
  signed_char: 0x06,
  unsigned: 0x07,
  unsigned_char: 0x08,
} as const;
