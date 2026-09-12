/**
 * A small expression language for watches, breakpoint conditions and logpoints —
 * Mesen's dialect with C's typed paths, not JavaScript, so a condition is cheap
 * to evaluate a million times a second and cannot run code.
 *
 *   registers      r0 … r15, sp, lr, pc, cpsr
 *   numbers        123, 0x1234, 0b101, 'A'
 *   symbols        gState, gState.hp, gLevels[i].width, p->hp, *p, &gState.hp
 *   casts          (T)x is the T at x's address; (T *)x is a pointer to a T
 *   constants      enumerators (MODE_PLAY), through the DWARF
 *   memory         [addr] (u8), {addr} (u16), u8(addr), u16(addr), u32(addr), s8/s16/s32(addr)
 *   machine        frame, scanline, cycle
 *   operators      postfix . -> [] ; unary - ! ~ * & (T) ; * / % ; + - ; << >> ;
 *                  < <= > >= ; == != ; & ; ^ ; | ; && ; || ; ?:
 *
 * Every value is a 32-bit word, as on the machine, together with what the program
 * says that word is. Signedness follows C's usual arithmetic conversions: a
 * decimal literal, a unary minus, an `s8/s16/s32()` read and a value of a signed
 * type are signed; hex, binary and char literals, the other reads, registers and
 * the machine values are unsigned; an operation on mixed operands is unsigned, and
 * the bitwise operators (`& | ^ ~ << >>`) work on the word and yield an unsigned
 * one. So `y < 0` holds for an `int y = -7`, and `g_frame - 10 < 0` does not for a
 * `u32 g_frame = 3`, exactly as in the program. Division by zero yields 0 rather
 * than aborting a run (Mesen's convention).
 *
 * Where the DWARF says a value is a pointer or an array, `+` and `-` step by the
 * element, as in C: `e + 1` is one Entity further on, `*(e + 1)` is `e[1]`, and
 * subtracting two pointers of one type counts elements. A machine value — a
 * register, a literal, a `u32()` or `[addr]` read — has no type, so it is never
 * scaled, and `*` refuses it rather than guessing a width.
 *
 * Expressions compile once to a closure over an {@link ExprEnv}. A type is a
 * property of the program, not of the moment, so every type is resolved at compile
 * time through {@link ExprHints} and the closures left behind carry only numbers —
 * an offset, a read width, a signedness flag.
 */
import type { TypeDesc } from '@gba-kit/debug-info';

/** Where a name keeps its value at this moment, or why it is nowhere. */
export type ExprPlace = { address: number } | { word: number } | { absent: string };

export interface ExprEnv {
  reg(index: number): number;
  cpsr(): number;
  /** Little-endian unsigned read; undefined when unmapped. */
  read(address: number, size: number): number | undefined;
  /**
   * A symbol or `symbol.member[3]` path → its current value as a 32-bit word (a
   * negative value of a narrower signed type sign-extended), or undefined when
   * unresolvable.
   */
  symbol(path: string): number | undefined;
  /** A symbol's address (for `&name`), a member path included. */
  symbolAddress(name: string): number | undefined;
  frame(): number;
  scanline(): number;
  cycle(): number;
  /**
   * Where the root name `name` keeps its value right now. A local's location
   * varies with the pc and may be a register, so this is asked per evaluation
   * rather than per compilation. An env that does not answer it falls back to
   * `symbol` and `symbolAddress`, which is what an env written against the older
   * interface provides.
   */
  place?(name: string): ExprPlace | undefined;
}

/** What the compiler may ask about the program, so the closure it builds is exact without an env. */
export interface ExprHints {
  /** Whether `path` names a value of a signed C type; undefined when unknown (taken as unsigned). */
  symbolSigned?(path: string): boolean | undefined;
  /** The C type of the root name `name` where this expression is compiled; undefined when it has none. */
  rootType?(name: string): TypeDesc | undefined;
  /** A type by its C spelling — `Entity`, `struct Entity`, `u16` — for a cast. */
  typeByName?(name: string): TypeDesc | undefined;
}

/** A bitfield inside the bytes a place names: LSB-first, and how many bytes cover it. */
export interface ExprBits {
  offset: number;
  size: number;
  span: number;
}

/**
 * The storage an expression names. `address` answers undefined when the value is
 * not in memory at this moment — the compiler keeps it in a register — which is a
 * fact only the machine has.
 */
export interface ExprLvalue {
  address: (env: ExprEnv) => number | undefined;
  /** the C type of what is stored there, absent when the program does not type it */
  type?: TypeDesc;
  bits?: ExprBits;
}

/**
 * A compiled expression: the value as the program would see it — negative when the
 * expression is signed and its top bit is set, else the unsigned word.
 */
export type CompiledExpr = (env: ExprEnv) => number;

/** A compiled expression, with what the program says its result is. */
export interface Compiled {
  value: CompiledExpr;
  /** the C type of the result, when the program states one */
  type: TypeDesc | null;
  /** what the expression names, when it names storage rather than computing a word */
  lvalue: ExprLvalue | null;
}

/** The widest literal a 32-bit machine holds. */
const U32_MAX = 0xffffffff;
/** Longer than this and it is not a condition anyone typed. */
const MAX_LENGTH = 4096;
/** Nesting bound for the recursive-descent parser, so a pathological expression cannot exhaust the stack. */
const MAX_DEPTH = 128;
/** C's qualifiers are part of a cast's spelling but not of the type the DWARF indexes. */
const QUALIFIERS = new Set(['const', 'volatile', 'restrict']);

const REGISTERS: Record<string, number> = { sp: 13, lr: 14, pc: 15 };
for (let i = 0; i < 16; i++) {
  REGISTERS[`r${i}`] = i;
}

type Token =
  | { kind: 'num'; value: number; decimal: boolean; at: number; end: number }
  | { kind: 'ident'; value: string; at: number; end: number }
  | { kind: 'op'; value: string; at: number; end: number }
  | { kind: 'end'; at: number; end: number };

const OPS = [
  '->',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '&',
  '|',
  '^',
  '!',
  '~',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '?',
  ':',
  ',',
  '.',
];

/**
 * A decimal, hex or binary literal as a 32-bit word. Throws when it does not fit,
 * instead of wrapping into a small number that looks like a valid address.
 */
export function parseU32Literal(text: string): number {
  const t = text.trim();
  const v = /^0b[01]+$/i.test(t) ? parseInt(t.slice(2), 2) : /^(0x[0-9a-f]+|\d+)$/i.test(t) ? Number(t) : NaN;
  if (Number.isNaN(v)) {
    throw new Error(`'${text}' is not a number`);
  }
  if (v > U32_MAX) {
    throw new Error(`number ${t} does not fit in 32 bits`);
  }
  return v;
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'" && text[i + 2] === "'") {
      out.push({ kind: 'num', value: text.charCodeAt(i + 1), decimal: false, at: i, end: i + 3 });
      i += 3;
      continue;
    }
    const num = /^(0x[0-9a-fA-F]+|0b[01]+|\d+)/.exec(text.slice(i));
    if (num) {
      const t = num[0]!;
      const decimal = /^\d/.test(t) && !/^0[xb]/i.test(t);
      out.push({ kind: 'num', value: parseU32Literal(t), decimal, at: i, end: i + t.length });
      i += t.length;
      continue;
    }
    const ident = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
    if (ident) {
      out.push({ kind: 'ident', value: ident[0]!, at: i, end: i + ident[0]!.length });
      i += ident[0]!.length;
      continue;
    }
    // A `.` right after a number is the one place it cannot be the member operator.
    if (ch === '.' && out[out.length - 1]?.kind === 'num') {
      throw new Error('floating-point values are not supported');
    }
    const op = OPS.find((o) => text.startsWith(o, i));
    if (op) {
      out.push({ kind: 'op', value: op, at: i, end: i + op.length });
      i += op.length;
      continue;
    }
    throw new Error(`unexpected '${ch}' at ${i}`);
  }
  out.push({ kind: 'end', at: text.length, end: text.length });
  return out;
}

const PRECEDENCE: Array<string[]> = [
  ['||'],
  ['&&'],
  ['|'],
  ['^'],
  ['&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['<<', '>>'],
  ['+', '-'],
  ['*', '/', '%'],
];

/**
 * A compiled sub-expression: its 32-bit word, how that word is to be read, and
 * what the program says it is.
 *
 * `type` is compile-time only. Every closure here captures numbers — an offset, a
 * width, a step — and never a {@link TypeDesc}, so a breakpoint condition costs
 * address arithmetic and memory reads and nothing else. Nothing type-checks that
 * rule; it has to be held in review.
 */
interface Node {
  /** always the unsigned word (`>>> 0`); throws for a value no 32-bit word holds */
  eval: (env: ExprEnv) => number;
  signed: boolean;
  type?: TypeDesc;
  /** where the value sits, when the expression names storage */
  lvalue?: ExprLvalue;
  /** the low 4 bytes as held, when the value is not in memory (the compiler kept the root in a register) */
  raw?: (env: ExprEnv) => number;
  /** the literal this node is, so a cast can reinterpret memory at `(u16)0x4000006` */
  literal?: number;
  /** the path text, while every step has been a constant one on a root the DWARF does not type */
  path?: string;
  /** the span of source this node came from, for the messages that quote it */
  text: string;
}

function unsigned(text: string, f: (env: ExprEnv) => number): Node {
  return { text, eval: f, signed: false };
}

function hex8(v: number): string {
  return (v >>> 0).toString(16).padStart(8, '0');
}

/** Whether a value of `type` is read as signed — the same rule the variables tree formats by. */
function signedOf(type: TypeDesc): boolean {
  return type.kind === 'int' || type.kind === 'char' || (type.kind === 'enum' && type.signed === true);
}

/** The width a scalar of `type` is read at, or 0 when no 32-bit word can hold it. */
function scalarWidth(type: TypeDesc): number {
  switch (type.kind) {
    case 'int':
    case 'uint':
    case 'bool':
    case 'char':
    case 'uchar':
    case 'enum':
      return type.size >= 1 && type.size <= 4 ? type.size : 0;
    case 'pointer':
      return type.size >= 1 && type.size <= 4 ? type.size : 4;
    default:
      return 0;
  }
}

/** Why this value is not a 32-bit word: the grammar's limit, said in the program's terms. */
function notScalar(text: string, type: TypeDesc): Error {
  if (type.kind === 'float') {
    return new Error(`'${text}' is a ${type.name}; the expression grammar works on 32-bit integers`);
  }
  if (type.kind === 'int' || type.kind === 'uint' || type.kind === 'enum') {
    return new Error(`'${text}' is a ${type.size}-byte ${type.name}; the expression grammar works on 32-bit values`);
  }
  return new Error(`'${text}' is a ${type.name}, not a scalar`);
}

function pointerTo(target: TypeDesc): TypeDesc {
  return { kind: 'pointer', name: `${target.name} *`, size: 4, target };
}

/** The element a pointer or array steps by, or undefined when the type is neither. */
function elementOf(type: TypeDesc | undefined): TypeDesc | undefined {
  return type && (type.kind === 'pointer' || type.kind === 'array') ? type.target : undefined;
}

function readWord(env: ExprEnv, address: number, size: number, signed: boolean): number {
  const a = address >>> 0;
  const v = env.read(a, size);
  if (v === undefined) {
    throw new Error(`unreadable address 0x${a.toString(16)}`);
  }
  const bits = size * 8;
  return signed && v >= 2 ** (bits - 1) ? (v - 2 ** bits) >>> 0 : v;
}

/** A word held in a register, read at the width of its own type. */
function maskWord(v: number, size: number, signed: boolean): number {
  if (size >= 4) {
    return v >>> 0;
  }
  const bits = size * 8;
  const u = (v >>> 0) % 2 ** bits;
  return signed && u >= 2 ** (bits - 1) ? (u - 2 ** bits) >>> 0 : u;
}

interface Located {
  text: string;
  type: TypeDesc;
  address: (env: ExprEnv) => number | undefined;
  raw?: (env: ExprEnv) => number;
  bits?: ExprBits;
}

/**
 * A value of a known type at a known place: the one shape every subscript, member,
 * arrow and dereference produces. An array's word is its own address, as C's decay
 * makes it, which is what lets `a[i]`, `*a` and `a + 1` treat an array and a
 * pointer alike.
 */
function locatedNode(l: Located): Node {
  const { text, type, address, raw, bits } = l;
  const node: Node = {
    text,
    signed: signedOf(type),
    type,
    lvalue: { address, type, bits },
    raw,
    eval: () => 0,
  };
  if (bits) {
    const { offset, size, span } = bits;
    const signed = signedOf(type);
    if (span > 4) {
      const err = new Error(`'${text}' is a ${size}-bit field spanning ${span} bytes, which is not a 32-bit read`);
      node.eval = () => {
        throw err;
      };
      return node;
    }
    node.eval = (env) => {
      const a = address(env);
      if (a === undefined) {
        throw new Error(`'${text}' is not available here: the compiler does not keep it in memory`);
      }
      const word = readWord(env, a, span, false);
      const v = Math.floor(word / 2 ** offset) % 2 ** size;
      return (signed && v >= 2 ** (size - 1) ? v - 2 ** size : v) >>> 0;
    };
    return node;
  }
  if (type.kind === 'array') {
    node.signed = false;
    node.eval = (env) => {
      const a = address(env);
      if (a === undefined) {
        throw new Error(`'${text}' is an array the compiler does not keep in memory here`);
      }
      return a >>> 0;
    };
    return node;
  }
  const size = scalarWidth(type);
  if (size === 0) {
    const err = notScalar(text, type);
    node.eval = () => {
      throw err;
    };
    return node;
  }
  const signed = signedOf(type);
  node.eval = (env) => {
    const a = address(env);
    if (a !== undefined) {
      return readWord(env, a, size, signed);
    }
    if (raw) {
      return maskWord(raw(env), size, signed);
    }
    throw new Error(`'${text}' is not available here: the compiler does not keep it in memory`);
  };
  return node;
}

class Parser {
  #pos = 0;
  #depth = 0;
  constructor(
    private readonly text: string,
    private readonly tokens: Token[],
    private readonly hints: ExprHints,
  ) {}

  parse(): Node {
    const expr = this.#ternary();
    if (this.tokens[this.#pos]!.kind !== 'end') {
      throw new Error(`unexpected token after expression`);
    }
    return expr;
  }

  #peek(offset = 0): Token {
    return this.tokens[Math.min(this.#pos + offset, this.tokens.length - 1)]!;
  }

  /** The source from `at` through the token just consumed: what an error message quotes. */
  #spanFrom(at: number): string {
    return this.text.slice(at, this.tokens[Math.max(this.#pos - 1, 0)]!.end).trim();
  }

  #takeOp(value: string): boolean {
    const t = this.#peek();
    if (t.kind === 'op' && t.value === value) {
      this.#pos++;
      return true;
    }
    return false;
  }

  #expectOp(value: string): void {
    if (!this.#takeOp(value)) {
      throw new Error(`expected '${value}'`);
    }
  }

  #ternary(): Node {
    if (++this.#depth > MAX_DEPTH) {
      throw new Error('expression nested too deeply');
    }
    try {
      const at = this.#peek().at;
      const cond = this.#binary(0);
      if (this.#takeOp('?')) {
        const a = this.#ternary();
        this.#expectOp(':');
        const b = this.#ternary();
        const c = cond.eval;
        return {
          text: this.#spanFrom(at),
          eval: (env) => (c(env) !== 0 ? a.eval(env) : b.eval(env)),
          signed: a.signed && b.signed,
        };
      }
      return cond;
    } finally {
      this.#depth--;
    }
  }

  #binary(level: number): Node {
    if (level >= PRECEDENCE.length) {
      return this.#unary();
    }
    const at = this.#peek().at;
    let left = this.#binary(level + 1);
    for (;;) {
      const t = this.#peek();
      if (t.kind !== 'op' || !PRECEDENCE[level]!.includes(t.value)) {
        return left;
      }
      this.#pos++;
      const right = this.#binary(level + 1);
      left = apply(t.value, left, right, this.#spanFrom(at));
    }
  }

  #unary(): Node {
    if (++this.#depth > MAX_DEPTH) {
      throw new Error('expression nested too deeply');
    }
    try {
      const at = this.#peek().at;
      if (this.#takeOp('-')) {
        const e = this.#unary().eval;
        return { text: this.#spanFrom(at), eval: (env) => -e(env) >>> 0, signed: true };
      }
      if (this.#takeOp('!')) {
        const e = this.#unary().eval;
        return unsigned(this.#spanFrom(at), (env) => (e(env) === 0 ? 1 : 0));
      }
      if (this.#takeOp('~')) {
        const e = this.#unary().eval;
        return unsigned(this.#spanFrom(at), (env) => ~e(env) >>> 0);
      }
      if (this.#takeOp('*')) {
        return dereference(this.#unary());
      }
      if (this.#takeOp('&')) {
        return addressOf(this.#unary());
      }
      const cast = this.#cast();
      if (cast) {
        return cast;
      }
      return this.#postfix();
    } finally {
      this.#depth--;
    }
  }

  /**
   * `(Entity *)x` against `(a + b) * c`, resolved the way a C compiler resolves it:
   * with the type table. The shape `( name… * … )` is checked first without asking
   * anything, so an arithmetic expression never reaches a lookup; a single unknown
   * name is an expression, since a program with a variable of that name is the
   * likelier reading and `(a) * b` has to keep working.
   */
  #cast(): Node | null {
    const open = this.#peek();
    if (open.kind !== 'op' || open.value !== '(') {
      return null;
    }
    let i = this.#pos + 1;
    const names: string[] = [];
    for (let t = this.tokens[i]!; t.kind === 'ident'; t = this.tokens[i]!) {
      names.push(t.value);
      i++;
    }
    if (names.length === 0) {
      return null;
    }
    let stars = 0;
    for (let t = this.tokens[i]!; t.kind === 'op' && t.value === '*'; t = this.tokens[i]!) {
      stars++;
      i++;
    }
    const close = this.tokens[i]!;
    if (close.kind !== 'op' || close.value !== ')') {
      return null;
    }
    const spelled = names.join(' ');
    const bare = names.filter((n) => !QUALIFIERS.has(n)).join(' ');
    const found = this.hints.typeByName?.(spelled) ?? (bare === spelled ? undefined : this.hints.typeByName?.(bare));
    if (!found) {
      if (stars > 0 || names.length > 1) {
        throw new Error(`unknown type '${spelled}' (the ELF has no DWARF for it)`);
      }
      return null;
    }
    this.#pos = i + 1;
    const at = open.at;
    let type = found;
    for (let s = 0; s < stars; s++) {
      type = pointerTo(type);
    }
    const operand = this.#unary();
    if (stars > 0) {
      // `(T *)x` is the pointer x is; `*(T *)x` and `((T *)x)->m` are what read through it.
      const value = operand.eval;
      return { text: this.#spanFrom(at), eval: (env) => value(env) >>> 0, signed: false, type };
    }
    return locatedNode({ text: this.#spanFrom(at), type, address: castAddress(operand, `(${spelled})`) });
  }

  /** `x.m`, `x->m` and `x[i]`, left to right, iteratively so a long chain costs no stack. */
  #postfix(): Node {
    const at = this.#peek().at;
    let node = this.#primary();
    for (;;) {
      const arrow = this.#peek().kind === 'op' && (this.#peek() as { value: string }).value === '->';
      if (arrow || (this.#peek().kind === 'op' && (this.#peek() as { value: string }).value === '.')) {
        this.#pos++;
        const name = this.#peek();
        if (name.kind !== 'ident') {
          throw new Error(`expected a member name after '${arrow ? '->' : '.'}'`);
        }
        this.#pos++;
        node =
          !arrow && node.path !== undefined
            ? this.#textualPath(`${node.path}.${name.value}`)
            : member(node, name.value, arrow);
        node.text = this.#spanFrom(at);
        continue;
      }
      if (this.#takeOp('[')) {
        const index = this.#ternary();
        this.#expectOp(']');
        node =
          node.path !== undefined && index.literal !== undefined
            ? this.#textualPath(`${node.path}[${index.literal}]`)
            : subscript(node, index);
        node.text = this.#spanFrom(at);
        continue;
      }
      return node;
    }
  }

  #primary(): Node {
    const t = this.#peek();
    if (t.kind === 'num') {
      this.#pos++;
      const v = t.value >>> 0;
      return { text: this.#spanFrom(t.at), eval: () => v, signed: t.decimal, literal: v };
    }
    if (t.kind === 'op' && t.value === '(') {
      // `(Foo)x` where the ELF has no `Foo`: the user meant a cast, so say the type is
      // missing rather than leave `x` as an unexpected token.
      const only = this.#peek(1).kind === 'ident' && isOp(this.#peek(2), ')') ? this.#peek(1) : null;
      this.#pos++;
      const e = this.#ternary();
      this.#expectOp(')');
      if (only !== null && startsPrimary(this.#peek())) {
        throw new Error(`unknown type '${(only as { value: string }).value}' (the ELF has no DWARF for it)`);
      }
      return e;
    }
    if (t.kind === 'op' && t.value === '[') {
      this.#pos++;
      const e = this.#ternary();
      this.#expectOp(']');
      return readOf(this.#spanFrom(t.at), e.eval, 1, false);
    }
    if (t.kind === 'op' && t.value === '{') {
      this.#pos++;
      const e = this.#ternary();
      this.#expectOp('}');
      return readOf(this.#spanFrom(t.at), e.eval, 2, false);
    }
    if (t.kind === 'ident') {
      this.#pos++;
      const name = t.value;
      const lower = name.toLowerCase();
      const reader = /^(u|s)(8|16|32)$/.exec(lower);
      if (reader && this.#takeOp('(')) {
        const e = this.#ternary();
        this.#expectOp(')');
        return readOf(this.#spanFrom(t.at), e.eval, (Number(reader[2]) / 8) as 1 | 2 | 4, reader[1] === 's');
      }
      if (lower in REGISTERS) {
        const index = REGISTERS[lower]!;
        return unsigned(name, (env) => env.reg(index) >>> 0);
      }
      switch (lower) {
        case 'cpsr':
          return unsigned(name, (env) => env.cpsr());
        case 'frame':
          return unsigned(name, (env) => env.frame());
        case 'scanline':
          return unsigned(name, (env) => env.scanline());
        case 'cycle':
          return unsigned(name, (env) => env.cycle());
        case 'true':
          return unsigned(name, () => 1);
        case 'false':
          return unsigned(name, () => 0);
      }
      const type = this.hints.rootType?.(name);
      return type ? typedRoot(name, type) : this.#textualPath(name);
    }
    throw new Error(
      t.kind === 'end' ? 'unexpected end of expression' : `unexpected '${(t as { value: string }).value}'`,
    );
  }

  /**
   * A root the DWARF does not type, and the constant path below it: the env answers
   * the whole path as text, which is what a symbol table alone can do and what an
   * env with no type hints relies on.
   */
  #textualPath(path: string): Node {
    return {
      text: path,
      path,
      signed: this.hints.symbolSigned?.(path) ?? false,
      eval: (env) => {
        const v = env.symbol(path);
        if (v === undefined) {
          throw new Error(`unknown symbol '${path}'`);
        }
        return v >>> 0;
      },
      lvalue: {
        address: (env) => {
          const a = env.symbolAddress(path);
          if (a === undefined || a === null) {
            throw new Error(`unknown symbol '${path}'`);
          }
          return a >>> 0;
        },
      },
    };
  }
}

function isOp(t: Token, value: string): boolean {
  return t.kind === 'op' && t.value === value;
}

/** Whether `t` could begin an operand, which is how `(Foo)x` is told from `(a) * b`. */
function startsPrimary(t: Token): boolean {
  return t.kind === 'ident' || t.kind === 'num' || isOp(t, '(');
}

/** A root the DWARF types: its word and its address both come from where the machine keeps it. */
function typedRoot(name: string, type: TypeDesc): Node {
  const width = scalarWidth(type) || 4;
  const signed = signedOf(type);
  const address = (env: ExprEnv): number | undefined => {
    const p = env.place?.(name);
    if (p === undefined) {
      const a = env.symbolAddress(name);
      return a === undefined || a === null ? undefined : a >>> 0;
    }
    if ('address' in p) {
      return p.address >>> 0;
    }
    if ('word' in p) {
      return undefined;
    }
    throw new Error(`'${name}' is not available here: ${p.absent}`);
  };
  const raw = (env: ExprEnv): number => {
    const p = env.place?.(name);
    if (p === undefined) {
      const v = env.symbol(name);
      if (v === undefined) {
        throw new Error(`unknown symbol '${name}'`);
      }
      return v >>> 0;
    }
    if ('word' in p) {
      return p.word >>> 0;
    }
    if ('address' in p) {
      return readWord(env, p.address, width, signed);
    }
    throw new Error(`'${name}' is not available here: ${p.absent}`);
  };
  return locatedNode({ text: name, type, address, raw });
}

/** `x.m` and `x->m`: the member's place, measured from the value or from the pointer. */
function member(base: Node, name: string, arrow: boolean): Node {
  const type = base.type;
  if (!type) {
    throw new Error(
      `'${base.text}' has no type in the debug info; cast it to reach through it, ` +
        `as in ((struct Foo *)${base.text})->${name}`,
    );
  }
  let owner: TypeDesc | undefined = type;
  let baseAddress: (env: ExprEnv) => number | undefined;
  let raw: ((env: ExprEnv) => number) | undefined;
  if (arrow) {
    if (type.kind !== 'pointer' && type.kind !== 'array') {
      throw new Error(`'${base.text}' (${type.name}) is not a pointer; use '.' for a member of a value`);
    }
    owner = type.target;
    const word = base.eval;
    baseAddress = (env) => word(env) >>> 0;
  } else {
    if (type.kind === 'pointer') {
      throw new Error(
        `'${base.text}' (${type.name}) is a pointer; read a member through it with '${base.text}->${name}'`,
      );
    }
    if (!base.lvalue) {
      throw new Error(`'${base.text}' is a value, not a place in memory`);
    }
    baseAddress = base.lvalue.address;
    raw = base.raw;
  }
  if (!owner || (owner.kind !== 'struct' && owner.kind !== 'union')) {
    throw new Error(`'${base.text}' (${type.name}) has no members`);
  }
  const m = owner.members?.find((x) => x.name === name);
  if (!m) {
    throw new Error(`'${base.text}' (${type.name}) has no member '${name}'`);
  }
  const bitSize = m.bitSize;
  const bitOffset = m.bitOffset;
  const bits: ExprBits | undefined =
    bitSize !== undefined && bitOffset !== undefined
      ? { offset: bitOffset % 8, size: bitSize, span: Math.ceil(((bitOffset % 8) + bitSize) / 8) }
      : undefined;
  const offset = bitOffset !== undefined && bits ? Math.floor(bitOffset / 8) : m.offset;
  const width = bits ? bits.span : scalarWidth(m.type);
  return locatedNode({
    text: `${base.text}${arrow ? '->' : '.'}${name}`,
    type: m.type,
    address: (env) => {
      const b = baseAddress(env);
      return b === undefined ? undefined : (b + offset) >>> 0;
    },
    // A ≤4-byte aggregate the compiler kept in a register has readable members, and
    // nothing else of it is knowable: past those bytes the value is not available.
    raw: raw && width > 0 && offset + width <= 4 ? (env) => (raw!(env) >>> (offset * 8)) >>> 0 : undefined,
    bits,
  });
}

/** `x[i]`, scaled by the element, on an array or a pointer alike. */
function subscript(base: Node, index: Node): Node {
  const type = base.type;
  if (!type) {
    throw new Error(
      base.path !== undefined
        ? `'${base.text}' has no type in the debug info; cast it to subscript it, ` +
            `as in ((struct Foo *)${base.text})[${index.text}]`
        : `cannot subscript '${base.text}': a plain 32-bit word has no element type — ` +
            `read the address with u8(${base.text} + n), u16() or u32()`,
    );
  }
  if (type.kind !== 'pointer' && type.kind !== 'array') {
    throw new Error(`'${base.text}' (${type.name}) is not an array or a pointer`);
  }
  const elem = type.target;
  if (!elem || !elem.size) {
    throw new Error(`'${base.text}' (${type.name}) has no element size in the debug info`);
  }
  // A constant index outside a sized array is a mistake the program can be measured
  // against; a runtime index is not, and neither is a pointer, which has no count.
  if (
    index.literal !== undefined &&
    type.kind === 'array' &&
    type.count !== null &&
    type.count !== undefined &&
    index.literal >= type.count
  ) {
    throw new Error(`index ${index.literal} is out of range for '${base.text}' (${type.name})`);
  }
  const step = elem.size;
  const word = base.eval;
  const at = index.eval;
  return locatedNode({
    text: `${base.text}[${index.text}]`,
    type: elem,
    address: (env) => (word(env) + Math.imul(at(env) | 0, step)) >>> 0,
  });
}

/** `*x`: the value the pointer points at. */
function dereference(x: Node): Node {
  const type = x.type;
  if (!type) {
    throw new Error(
      `cannot dereference '${x.text}': a plain 32-bit word is not a typed pointer — ` +
        `read what is there with u8(${x.text}), u16(${x.text}) or u32(${x.text})`,
    );
  }
  if (type.kind !== 'pointer' && type.kind !== 'array') {
    throw new Error(`cannot dereference '${x.text}': it is a ${type.name}, not a pointer`);
  }
  const target = type.target;
  if (!target) {
    throw new Error(`cannot dereference '${x.text}': the debug info does not say what a ${type.name} points at`);
  }
  const word = x.eval;
  return locatedNode({ text: `*${x.text}`, type: target, address: (env) => word(env) >>> 0 });
}

/** `&x`: the place x names, as a pointer to it. */
function addressOf(x: Node): Node {
  const lvalue = x.lvalue;
  if (!lvalue) {
    throw new Error(`cannot take the address of '${x.text}': it is a value, not a place in memory`);
  }
  const address = lvalue.address;
  return {
    text: `&${x.text}`,
    signed: false,
    type: lvalue.type ? pointerTo(lvalue.type) : undefined,
    eval: (env) => {
      const a = address(env);
      if (a === undefined) {
        throw new Error(`cannot take the address of '${x.text}': the compiler keeps it in a register here`);
      }
      return a >>> 0;
    },
  };
}

/**
 * Where `(T)operand` reads: the place the operand names, the literal it is, or —
 * for anything else — the value it computes, which has to be an address the machine
 * can read or the cast is reinterpreting a number as memory.
 */
function castAddress(operand: Node, spelled: string): (env: ExprEnv) => number {
  if (operand.literal !== undefined) {
    const at = operand.literal >>> 0;
    return () => at;
  }
  if (operand.lvalue) {
    const address = operand.lvalue.address;
    return (env) => {
      const a = address(env);
      if (a === undefined) {
        throw new Error(`a cast reads memory at '${operand.text}', which the compiler keeps in a register here`);
      }
      return a >>> 0;
    };
  }
  const word = operand.eval;
  return (env) => {
    const a = word(env) >>> 0;
    if (env.read(a, 1) === undefined) {
      throw new Error(
        `'${operand.text}' evaluates to 0x${hex8(a)}, which is not a readable address — a cast reinterprets memory ` +
          `at the operand; use ${spelled}&${operand.text} to read the variable, or drop the cast to see its value`,
      );
    }
    return a;
  };
}

function readOf(text: string, address: (env: ExprEnv) => number, size: 1 | 2 | 4, signed: boolean): Node {
  const bits = size * 8;
  return {
    text,
    eval: (env) => {
      const a = address(env) >>> 0;
      const v = env.read(a, size);
      if (v === undefined) {
        throw new Error(`unreadable address 0x${a.toString(16)}`);
      }
      return signed && v >= 2 ** (bits - 1) ? (v - 2 ** bits) >>> 0 : v;
    },
    signed,
  };
}

function apply(op: string, l: Node, r: Node, text: string): Node {
  const a = l.eval;
  const b = r.eval;
  // C's usual arithmetic conversions: an operation is signed only when both sides are.
  const signed = l.signed && r.signed;
  if (op === '+' || op === '-') {
    const scaled = scale(op, l, r, text);
    if (scaled) {
      return scaled;
    }
  }
  switch (op) {
    case '||':
      return unsigned(text, (env) => (a(env) !== 0 || b(env) !== 0 ? 1 : 0));
    case '&&':
      return unsigned(text, (env) => (a(env) !== 0 && b(env) !== 0 ? 1 : 0));
    case '|':
      return unsigned(text, (env) => (a(env) | b(env)) >>> 0);
    case '^':
      return unsigned(text, (env) => (a(env) ^ b(env)) >>> 0);
    case '&':
      return unsigned(text, (env) => (a(env) & b(env)) >>> 0);
    case '==':
      return unsigned(text, (env) => (a(env) === b(env) ? 1 : 0));
    case '!=':
      return unsigned(text, (env) => (a(env) !== b(env) ? 1 : 0));
    case '<':
      return unsignedBool(text, signed ? (env) => (a(env) | 0) < (b(env) | 0) : (env) => a(env) < b(env));
    case '<=':
      return unsignedBool(text, signed ? (env) => (a(env) | 0) <= (b(env) | 0) : (env) => a(env) <= b(env));
    case '>':
      return unsignedBool(text, signed ? (env) => (a(env) | 0) > (b(env) | 0) : (env) => a(env) > b(env));
    case '>=':
      return unsignedBool(text, signed ? (env) => (a(env) | 0) >= (b(env) | 0) : (env) => a(env) >= b(env));
    case '<<':
      // A count of 32 or more shifts everything out, as the ARM barrel shifter does
      // (JavaScript would silently use the count modulo 32).
      return unsigned(text, (env) => shiftLeft(a(env), b(env)));
    case '>>':
      return unsigned(text, (env) => shiftRight(a(env), b(env)));
    case '+':
      return { text, eval: (env) => (a(env) + b(env)) >>> 0, signed };
    case '-':
      return { text, eval: (env) => (a(env) - b(env)) >>> 0, signed };
    case '*':
      return { text, eval: (env) => Math.imul(a(env), b(env)) >>> 0, signed };
    case '/':
      // Division by zero is 0, never an error: a condition must not abort the run.
      return {
        text,
        eval: signed
          ? (env) => {
              const d = b(env) | 0;
              return d === 0 ? 0 : Math.trunc((a(env) | 0) / d) >>> 0;
            }
          : (env) => {
              const d = b(env);
              return d === 0 ? 0 : Math.trunc(a(env) / d) >>> 0;
            },
        signed,
      };
    case '%':
      return {
        text,
        eval: signed
          ? (env) => {
              const d = b(env) | 0;
              return d === 0 ? 0 : ((a(env) | 0) % d) >>> 0;
            }
          : (env) => {
              const d = b(env);
              return d === 0 ? 0 : (a(env) % d) >>> 0;
            },
        signed,
      };
    default:
      throw new Error(`unknown operator ${op}`);
  }
}

/**
 * C's pointer arithmetic, where and only where a type says pointer or array:
 * `e + 1` steps one element, and one pointer minus another counts them. Everything
 * else — a register, a literal, a `u32()` read, a machine value — has no type and
 * keeps the raw word, so `r3 + 1` and `u32(a) + 1` mean what they always did, and
 * so do `p & 3` and `p * 2`, which are not pointer arithmetic in C either.
 */
function scale(op: '+' | '-', l: Node, r: Node, text: string): Node | null {
  const le = elementOf(l.type);
  const re = elementOf(r.type);
  const a = l.eval;
  const b = r.eval;
  if (le && re) {
    if (op === '+') {
      throw new Error(`cannot add two pointers ('${l.text}' and '${r.text}')`);
    }
    if (le.size !== re.size || !le.size) {
      throw new Error(
        `cannot subtract '${r.text}' (${r.type!.name}) from '${l.text}' (${l.type!.name}): they point at different types`,
      );
    }
    const step = le.size;
    return { text, signed: true, eval: (env) => Math.trunc(((a(env) - b(env)) | 0) / step) >>> 0 };
  }
  const elem = le ?? re;
  if (!elem) {
    return null;
  }
  if (re && op === '-') {
    throw new Error(`cannot subtract '${r.text}' (${r.type!.name}) from '${l.text}', which is not a pointer`);
  }
  // A void or incomplete pointee has no width to step by, so it steps by the byte, as GDB does in C.
  const step = elem.size || 1;
  const pointer = le ? a : b;
  const count = le ? b : a;
  const type = pointerTo(elem);
  const stepped =
    op === '+'
      ? (env: ExprEnv) => (pointer(env) + Math.imul(count(env) | 0, step)) >>> 0
      : (env: ExprEnv) => (pointer(env) - Math.imul(count(env) | 0, step)) >>> 0;
  return { text, signed: false, type, eval: stepped };
}

function unsignedBool(text: string, p: (env: ExprEnv) => boolean): Node {
  return unsigned(text, (env) => (p(env) ? 1 : 0));
}

function shiftLeft(v: number, n: number): number {
  return n >= 32 ? 0 : (v << n) >>> 0;
}

function shiftRight(v: number, n: number): number {
  return n >= 32 ? 0 : v >>> n;
}

/** Compile `text`, with what the program says its result is; throws with a message on a syntax error. */
export function compile(text: string, hints: ExprHints = {}): Compiled {
  if (text.length > MAX_LENGTH) {
    throw new Error(`expression too long (${text.length} chars, max ${MAX_LENGTH})`);
  }
  const node = new Parser(text, tokenize(text), hints).parse();
  const f = node.eval;
  return {
    value: node.signed ? (env) => f(env) | 0 : f,
    type: node.type ?? null,
    lvalue: node.lvalue ?? null,
  };
}

/** Compile `text` to its value alone; throws with a message on a syntax error. */
export function compileExpression(text: string, hints: ExprHints = {}): CompiledExpr {
  return compile(text, hints).value;
}

/**
 * Split a console line into the place to write and the value to write there, or null
 * when the line is an expression to evaluate. The `=` that separates them is the first
 * one that is not part of `==`, `!=`, `<=` or `>=`, so `a == b` is a comparison and
 * `a = b == c` writes the comparison's result. A compound operator (`+=`) is refused by
 * name rather than left to fail as the unreadable target `a +`.
 */
export function splitAssignment(line: string): { target: string; value: string } | null {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      quoted = !quoted;
      continue;
    }
    if (quoted || c !== '=') {
      continue;
    }
    if (line[i + 1] === '=') {
      i++; // ==
      continue;
    }
    const before = line[i - 1] ?? '';
    if (before === '!' || before === '<' || before === '>') {
      continue;
    }
    if (before !== '' && '+-*/%&|^'.includes(before)) {
      throw new Error(`'${before}=' is not supported; write the whole value, as in 'x = x ${before} 1'`);
    }
    const target = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (target === '' || value === '') {
      throw new Error(`an assignment needs a place and a value, as in 'g_player.pos.x = 10'`);
    }
    return { target, value };
  }
  return null;
}

/** `value` as an expression result reads: decimal, with the hex word beside it. */
export function formatNumber(value: number): string {
  return `${value} (0x${(value >>> 0).toString(16)})`;
}

/**
 * Interpolate `{expr}` fragments in a logpoint message; braces nest, so `{{addr}}`
 * is the u16 read of the grammar. A fragment that fails to evaluate shows its error
 * in place, so a bad message never breaks the run; an unterminated `{` is text.
 */
export function compileLogMessage(message: string, hints: ExprHints = {}): (env: ExprEnv) => string {
  const parts: Array<string | CompiledExpr> = [];
  let last = 0;
  for (let i = 0; i < message.length; i++) {
    if (message[i] !== '{') {
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let j = i; j < message.length; j++) {
      if (message[j] === '{') {
        depth++;
      } else if (message[j] === '}' && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end < 0) {
      break;
    }
    const expr = message.slice(i + 1, end);
    parts.push(message.slice(last, i));
    try {
      parts.push(compileExpression(expr, hints));
    } catch (err) {
      parts.push(`{${expr}: ${(err as Error).message}}`);
    }
    last = end + 1;
    i = end;
  }
  parts.push(message.slice(last));
  return (env) =>
    parts
      .map((p) => {
        if (typeof p === 'string') {
          return p;
        }
        try {
          return formatNumber(p(env));
        } catch (err) {
          return `{${(err as Error).message}}`;
        }
      })
      .join('');
}

/** `count`, `>= count`, `== count`, `% count`: DAP's hit-condition grammar. Hits are counted from 1. */
export function compileHitCondition(text: string): (hits: number) => boolean {
  const m = /^\s*(==|>=|>|<=|<|%)?\s*(\d+)\s*$/.exec(text);
  if (!m) {
    throw new Error(`hit condition must look like '5', '>= 5' or '% 5'`);
  }
  const n = Number(m[2]);
  const op = m[1] ?? '>=';
  if (n === 0 && (op === '%' || op === '==' || op === '<' || op === '<=')) {
    throw new Error(`hit condition '${text.trim()}' can never be satisfied: hits are counted from 1`);
  }
  switch (op) {
    case '==':
      return (h) => h === n;
    case '>':
      return (h) => h > n;
    case '<':
      return (h) => h < n;
    case '<=':
      return (h) => h <= n;
    case '%':
      return (h) => h % n === 0;
    default:
      return (h) => h >= n;
  }
}
