/**
 * A small expression language for watches, breakpoint conditions and logpoints —
 * Mesen's dialect, not JavaScript, so a condition is cheap to evaluate a million
 * times a second and cannot run code.
 *
 *   registers      r0 … r15, sp, lr, pc, cpsr
 *   numbers        123, 0x1234, 0b101, 'A'
 *   symbols        gState, gState.hp, gLevels[2].width   (through the DWARF; constant subscripts only)
 *   constants      enumerators (MODE_PLAY), through the DWARF
 *   memory         [addr] (u8), {addr} (u16), u8(addr), u16(addr), u32(addr), s8/s16/s32(addr)
 *   machine        frame, scanline, cycle
 *   operators      unary - ! ~ ; * / % ; + - ; << >> ; < <= > >= ; == != ; & ; ^ ; | ; && ; || ; ?:
 *
 * Every value is a 32-bit word, as on the machine. Signedness follows C's usual
 * arithmetic conversions: a decimal literal, a unary minus, an `s8/s16/s32()` read
 * and a symbol of a signed type are signed; hex, binary and char literals, the
 * other reads, registers and the machine values are unsigned; an operation on
 * mixed operands is unsigned, and the bitwise operators (`& | ^ ~ << >>`) work on
 * the word and yield an unsigned one. So `y < 0` holds for an `int y = -7`, and
 * `g_frame - 10 < 0` does not for a `u32 g_frame = 3`, exactly as in the program.
 * Division by zero yields 0 rather than aborting a run (Mesen's convention).
 *
 * Expressions compile once to a closure over an {@link ExprEnv}. A symbol's
 * signedness is a property of its DWARF type, not of the moment, so it is
 * resolved at compile time through {@link ExprHints}.
 */

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
}

/** What the compiler may ask about the program, so the closure it builds is exact without an env. */
export interface ExprHints {
  /** Whether `path` names a value of a signed C type; undefined when unknown (taken as unsigned). */
  symbolSigned?(path: string): boolean | undefined;
}

/**
 * A compiled expression: the value as the program would see it — negative when the
 * expression is signed and its top bit is set, else the unsigned word.
 */
export type CompiledExpr = (env: ExprEnv) => number;

/** The widest literal a 32-bit machine holds. */
const U32_MAX = 0xffffffff;
/** Longer than this and it is not a condition anyone typed; also bounds the error echo. */
const MAX_LENGTH = 4096;
/** Deeper nesting than this overflows the recursive-descent parser's stack before it means anything. */
const MAX_DEPTH = 128;

const SUBSCRIPT_HINT =
  'only constant subscripts and .member paths are supported (gEntityInfo[3].id); for a variable index, ' +
  'pointer (->) or dereference (*p), compute the address and read it with u8/u16/u32(addr)';

const REGISTERS: Record<string, number> = { sp: 13, lr: 14, pc: 15 };
for (let i = 0; i < 16; i++) {
  REGISTERS[`r${i}`] = i;
}

type Token =
  | { kind: 'num'; value: number; decimal: boolean }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'end' };

const OPS = [
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
      out.push({ kind: 'num', value: text.charCodeAt(i + 1), decimal: false });
      i += 3;
      continue;
    }
    const num = /^(0x[0-9a-fA-F]+|0b[01]+|\d+)/.exec(text.slice(i));
    if (num) {
      const t = num[0]!;
      out.push({ kind: 'num', value: parseU32Literal(t), decimal: /^\d/.test(t) && !/^0[xb]/i.test(t) });
      i += t.length;
      continue;
    }
    const ident = /^[A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[\d+\]))*/.exec(text.slice(i));
    if (ident) {
      out.push({ kind: 'ident', value: ident[0]! });
      i += ident[0]!.length;
      continue;
    }
    if (ch === '.') {
      throw new Error(`unexpected '.' at ${i}: ${SUBSCRIPT_HINT}`);
    }
    const op = OPS.find((o) => text.startsWith(o, i));
    if (op) {
      out.push({ kind: 'op', value: op });
      i += op.length;
      continue;
    }
    throw new Error(`unexpected '${ch}' at ${i}`);
  }
  out.push({ kind: 'end' });
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

/** A compiled sub-expression: its 32-bit word, and how that word is to be read. */
interface Node {
  /** always the unsigned word (`>>> 0`) */
  eval: (env: ExprEnv) => number;
  signed: boolean;
}

function unsigned(f: (env: ExprEnv) => number): Node {
  return { eval: f, signed: false };
}

class Parser {
  #pos = 0;
  #depth = 0;
  constructor(
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
      const cond = this.#binary(0);
      if (this.#takeOp('?')) {
        const a = this.#ternary();
        this.#expectOp(':');
        const b = this.#ternary();
        const c = cond.eval;
        return { eval: (env) => (c(env) !== 0 ? a.eval(env) : b.eval(env)), signed: a.signed && b.signed };
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
    let left = this.#binary(level + 1);
    for (;;) {
      const t = this.#peek();
      if (t.kind !== 'op' || !PRECEDENCE[level]!.includes(t.value)) {
        return left;
      }
      this.#pos++;
      const right = this.#binary(level + 1);
      left = apply(t.value, left, right);
    }
  }

  #unary(): Node {
    if (this.#takeOp('-')) {
      const e = this.#unary().eval;
      return { eval: (env) => -e(env) >>> 0, signed: true };
    }
    if (this.#takeOp('!')) {
      const e = this.#unary().eval;
      return unsigned((env) => (e(env) === 0 ? 1 : 0));
    }
    if (this.#takeOp('~')) {
      const e = this.#unary().eval;
      return unsigned((env) => ~e(env) >>> 0);
    }
    if (this.#peek().kind === 'op' && (this.#peek() as { value: string }).value === '*') {
      throw new Error(`unexpected '*': pointer dereference is not supported; read the address with u32(addr)`);
    }
    if (this.#takeOp('&')) {
      const t = this.#peek();
      if (t.kind !== 'ident') {
        throw new Error("'&' needs a symbol");
      }
      this.#pos++;
      const name = t.value;
      return unsigned((env) => {
        const a = env.symbolAddress(name);
        if (a === undefined) {
          throw new Error(`unknown symbol '${name}'`);
        }
        return a >>> 0;
      });
    }
    return this.#primary();
  }

  #primary(): Node {
    const t = this.#peek();
    if (t.kind === 'num') {
      this.#pos++;
      const v = t.value >>> 0;
      return { eval: () => v, signed: t.decimal };
    }
    if (t.kind === 'op' && t.value === '(') {
      this.#pos++;
      const e = this.#ternary();
      this.#expectOp(')');
      return e;
    }
    if (t.kind === 'op' && t.value === '[') {
      this.#pos++;
      const e = this.#ternary();
      this.#expectOp(']');
      return readOf(e.eval, 1, false);
    }
    if (t.kind === 'op' && t.value === '{') {
      this.#pos++;
      const e = this.#ternary();
      this.#expectOp('}');
      return readOf(e.eval, 2, false);
    }
    if (t.kind === 'ident') {
      this.#pos++;
      const name = t.value;
      const lower = name.toLowerCase();
      const reader = /^(u|s)(8|16|32)$/.exec(lower);
      if (reader && this.#takeOp('(')) {
        const e = this.#ternary();
        this.#expectOp(')');
        return readOf(e.eval, (Number(reader[2]) / 8) as 1 | 2 | 4, reader[1] === 's');
      }
      this.#rejectUnsupportedPath();
      if (lower in REGISTERS) {
        const index = REGISTERS[lower]!;
        return unsigned((env) => env.reg(index) >>> 0);
      }
      switch (lower) {
        case 'cpsr':
          return unsigned((env) => env.cpsr());
        case 'frame':
          return unsigned((env) => env.frame());
        case 'scanline':
          return unsigned((env) => env.scanline());
        case 'cycle':
          return unsigned((env) => env.cycle());
        case 'true':
          return unsigned(() => 1);
        case 'false':
          return unsigned(() => 0);
      }
      return {
        eval: (env) => {
          const v = env.symbol(name);
          if (v === undefined) {
            throw new Error(`unknown symbol '${name}'`);
          }
          return v >>> 0;
        },
        signed: this.hints.symbolSigned?.(name) ?? false,
      };
    }
    throw new Error(
      t.kind === 'end' ? 'unexpected end of expression' : `unexpected '${(t as { value: string }).value}'`,
    );
  }

  /** After a symbol: `a[expr]` and `a->b` are C, not this grammar; say so instead of "unexpected token". */
  #rejectUnsupportedPath(): void {
    const next = this.#peek();
    if (next.kind !== 'op') {
      return;
    }
    const after = this.#peek(1);
    if (next.value === '[' || (next.value === '-' && after.kind === 'op' && after.value === '>')) {
      throw new Error(SUBSCRIPT_HINT);
    }
  }
}

function readOf(address: (env: ExprEnv) => number, size: 1 | 2 | 4, signed: boolean): Node {
  const bits = size * 8;
  return {
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

function apply(op: string, l: Node, r: Node): Node {
  const a = l.eval;
  const b = r.eval;
  // C's usual arithmetic conversions: an operation is signed only when both sides are.
  const signed = l.signed && r.signed;
  switch (op) {
    case '||':
      return unsigned((env) => (a(env) !== 0 || b(env) !== 0 ? 1 : 0));
    case '&&':
      return unsigned((env) => (a(env) !== 0 && b(env) !== 0 ? 1 : 0));
    case '|':
      return unsigned((env) => (a(env) | b(env)) >>> 0);
    case '^':
      return unsigned((env) => (a(env) ^ b(env)) >>> 0);
    case '&':
      return unsigned((env) => (a(env) & b(env)) >>> 0);
    case '==':
      return unsigned((env) => (a(env) === b(env) ? 1 : 0));
    case '!=':
      return unsigned((env) => (a(env) !== b(env) ? 1 : 0));
    case '<':
      return unsignedBool(signed ? (env) => (a(env) | 0) < (b(env) | 0) : (env) => a(env) < b(env));
    case '<=':
      return unsignedBool(signed ? (env) => (a(env) | 0) <= (b(env) | 0) : (env) => a(env) <= b(env));
    case '>':
      return unsignedBool(signed ? (env) => (a(env) | 0) > (b(env) | 0) : (env) => a(env) > b(env));
    case '>=':
      return unsignedBool(signed ? (env) => (a(env) | 0) >= (b(env) | 0) : (env) => a(env) >= b(env));
    case '<<':
      // A count of 32 or more shifts everything out, as the ARM barrel shifter does
      // (JavaScript would silently use the count modulo 32).
      return unsigned((env) => shiftLeft(a(env), b(env)));
    case '>>':
      return unsigned((env) => shiftRight(a(env), b(env)));
    case '+':
      return { eval: (env) => (a(env) + b(env)) >>> 0, signed };
    case '-':
      return { eval: (env) => (a(env) - b(env)) >>> 0, signed };
    case '*':
      return { eval: (env) => Math.imul(a(env), b(env)) >>> 0, signed };
    case '/':
      // Division by zero is 0, never an error: a condition must not abort the run.
      return {
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

/** A comparison's 0/1 from a predicate. */
function unsignedBool(p: (env: ExprEnv) => boolean): Node {
  return unsigned((env) => (p(env) ? 1 : 0));
}

function shiftLeft(v: number, n: number): number {
  return n >= 32 ? 0 : (v << n) >>> 0;
}

function shiftRight(v: number, n: number): number {
  return n >= 32 ? 0 : v >>> n;
}

/** Compile `text`; throws with a message on a syntax error. */
export function compileExpression(text: string, hints: ExprHints = {}): CompiledExpr {
  if (text.length > MAX_LENGTH) {
    throw new Error(`expression too long (${text.length} chars, max ${MAX_LENGTH})`);
  }
  const node = new Parser(tokenize(text), hints).parse();
  const f = node.eval;
  return node.signed ? (env) => f(env) | 0 : f;
}

/** `value` as an expression result reads: decimal, with the hex word for anything past a digit. */
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
