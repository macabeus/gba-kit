/**
 * A small expression language for watches, breakpoint conditions and logpoints —
 * Mesen's dialect, not JavaScript, so a condition is cheap to evaluate a million
 * times a second and cannot run code.
 *
 *   registers      r0 … r15, sp, lr, pc, cpsr
 *   numbers        123, 0x1234, 0b101, 'A'
 *   symbols        gState, gState.hp, gLevels[2].width   (through the DWARF)
 *   memory         [addr] (u8), {addr} (u16), u8(addr), u16(addr), u32(addr), s8/s16/s32(addr)
 *   machine        frame, scanline, cycle
 *   operators      unary - ! ~ ; * / % ; + - ; << >> ; < <= > >= ; == != ; & ; ^ ; | ; && ; || ; ?:
 *
 * Expressions compile once to a closure over an {@link ExprEnv}.
 */

export interface ExprEnv {
  reg(index: number): number;
  cpsr(): number;
  /** Little-endian unsigned read; undefined when unmapped. */
  read(address: number, size: number): number | undefined;
  /** A symbol or `symbol.member[3]` path → its current value, or undefined when unresolvable. */
  symbol(path: string): number | undefined;
  /** A symbol's address (for `&name`). */
  symbolAddress(name: string): number | undefined;
  frame(): number;
  scanline(): number;
  cycle(): number;
}

export type CompiledExpr = (env: ExprEnv) => number;

const REGISTERS: Record<string, number> = { sp: 13, lr: 14, pc: 15 };
for (let i = 0; i < 16; i++) {
  REGISTERS[`r${i}`] = i;
}

type Token =
  | { kind: 'num'; value: number }
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
      out.push({ kind: 'num', value: text.charCodeAt(i + 1) });
      i += 3;
      continue;
    }
    const num = /^(0x[0-9a-fA-F]+|0b[01]+|\d+)/.exec(text.slice(i));
    if (num) {
      const t = num[0]!;
      out.push({ kind: 'num', value: t.startsWith('0b') ? parseInt(t.slice(2), 2) : Number(t) });
      i += t.length;
      continue;
    }
    const ident = /^[A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[\d+\]))*/.exec(text.slice(i));
    if (ident) {
      out.push({ kind: 'ident', value: ident[0]! });
      i += ident[0]!.length;
      continue;
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

class Parser {
  #pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): CompiledExpr {
    const expr = this.#ternary();
    if (this.tokens[this.#pos]!.kind !== 'end') {
      throw new Error(`unexpected token after expression`);
    }
    return expr;
  }

  #peek(): Token {
    return this.tokens[this.#pos]!;
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

  #ternary(): CompiledExpr {
    const cond = this.#binary(0);
    if (this.#takeOp('?')) {
      const a = this.#ternary();
      this.#expectOp(':');
      const b = this.#ternary();
      return (env) => (cond(env) !== 0 ? a(env) : b(env));
    }
    return cond;
  }

  #binary(level: number): CompiledExpr {
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

  #unary(): CompiledExpr {
    if (this.#takeOp('-')) {
      const e = this.#unary();
      return (env) => -e(env) >>> 0;
    }
    if (this.#takeOp('!')) {
      const e = this.#unary();
      return (env) => (e(env) === 0 ? 1 : 0);
    }
    if (this.#takeOp('~')) {
      const e = this.#unary();
      return (env) => ~e(env) >>> 0;
    }
    if (this.#takeOp('&')) {
      const t = this.#peek();
      if (t.kind !== 'ident') {
        throw new Error("'&' needs a symbol");
      }
      this.#pos++;
      const name = t.value;
      return (env) => {
        const a = env.symbolAddress(name);
        if (a === undefined) {
          throw new Error(`unknown symbol '${name}'`);
        }
        return a;
      };
    }
    return this.#primary();
  }

  #primary(): CompiledExpr {
    const t = this.#peek();
    if (t.kind === 'num') {
      this.#pos++;
      const v = t.value >>> 0;
      return () => v;
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
      return readOf(e, 1, false);
    }
    if (t.kind === 'op' && t.value === '{') {
      this.#pos++;
      const e = this.#ternary();
      this.#expectOp('}');
      return readOf(e, 2, false);
    }
    if (t.kind === 'ident') {
      this.#pos++;
      const name = t.value;
      const lower = name.toLowerCase();
      const reader = /^(u|s)(8|16|32)$/.exec(lower);
      if (reader && this.#takeOp('(')) {
        const e = this.#ternary();
        this.#expectOp(')');
        return readOf(e, (Number(reader[2]) / 8) as 1 | 2 | 4, reader[1] === 's');
      }
      if (lower in REGISTERS) {
        const index = REGISTERS[lower]!;
        return (env) => env.reg(index) >>> 0;
      }
      switch (lower) {
        case 'cpsr':
          return (env) => env.cpsr();
        case 'frame':
          return (env) => env.frame();
        case 'scanline':
          return (env) => env.scanline();
        case 'cycle':
          return (env) => env.cycle();
        case 'true':
          return () => 1;
        case 'false':
          return () => 0;
      }
      return (env) => {
        const v = env.symbol(name);
        if (v === undefined) {
          throw new Error(`unknown symbol '${name}'`);
        }
        return v;
      };
    }
    throw new Error(
      t.kind === 'end' ? 'unexpected end of expression' : `unexpected '${(t as { value: string }).value}'`,
    );
  }
}

function readOf(address: CompiledExpr, size: 1 | 2 | 4, signed: boolean): CompiledExpr {
  return (env) => {
    const a = address(env) >>> 0;
    const v = env.read(a, size);
    if (v === undefined) {
      throw new Error(`unreadable address 0x${a.toString(16)}`);
    }
    if (!signed) {
      return v;
    }
    const bits = size * 8;
    return v >= 2 ** (bits - 1) ? (v - 2 ** bits) >>> 0 : v;
  };
}

function apply(op: string, a: CompiledExpr, b: CompiledExpr): CompiledExpr {
  switch (op) {
    case '||':
      return (env) => (a(env) !== 0 || b(env) !== 0 ? 1 : 0);
    case '&&':
      return (env) => (a(env) !== 0 && b(env) !== 0 ? 1 : 0);
    case '|':
      return (env) => (a(env) | b(env)) >>> 0;
    case '^':
      return (env) => (a(env) ^ b(env)) >>> 0;
    case '&':
      return (env) => (a(env) & b(env)) >>> 0;
    case '==':
      return (env) => (a(env) >>> 0 === b(env) >>> 0 ? 1 : 0);
    case '!=':
      return (env) => (a(env) >>> 0 !== b(env) >>> 0 ? 1 : 0);
    case '<':
      return (env) => (a(env) < b(env) ? 1 : 0);
    case '<=':
      return (env) => (a(env) <= b(env) ? 1 : 0);
    case '>':
      return (env) => (a(env) > b(env) ? 1 : 0);
    case '>=':
      return (env) => (a(env) >= b(env) ? 1 : 0);
    case '<<':
      return (env) => (a(env) << b(env)) >>> 0;
    case '>>':
      return (env) => a(env) >>> b(env);
    case '+':
      return (env) => (a(env) + b(env)) >>> 0;
    case '-':
      return (env) => (a(env) - b(env)) >>> 0;
    case '*':
      return (env) => Math.imul(a(env), b(env)) >>> 0;
    case '/':
      return (env) => {
        const d = b(env);
        return d === 0 ? 0 : Math.trunc(a(env) / d) >>> 0;
      };
    case '%':
      return (env) => {
        const d = b(env);
        return d === 0 ? 0 : (a(env) % d) >>> 0;
      };
    default:
      throw new Error(`unknown operator ${op}`);
  }
}

/** Compile `text`; throws with a message on a syntax error. */
export function compileExpression(text: string): CompiledExpr {
  return new Parser(tokenize(text)).parse();
}

/**
 * Interpolate `{expr}` fragments in a logpoint message. A fragment that fails to
 * evaluate shows its error in place, so a bad message never breaks the run.
 */
export function compileLogMessage(message: string): (env: ExprEnv) => string {
  const parts: Array<string | CompiledExpr> = [];
  const re = /\{([^{}]+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message))) {
    parts.push(message.slice(last, m.index));
    try {
      parts.push(compileExpression(m[1]!));
    } catch (err) {
      const text = `{${m[1]}: ${(err as Error).message}}`;
      parts.push(text);
    }
    last = m.index + m[0].length;
  }
  parts.push(message.slice(last));
  return (env) =>
    parts
      .map((p) => {
        if (typeof p === 'string') {
          return p;
        }
        try {
          const v = p(env);
          return `${v} (0x${v.toString(16)})`;
        } catch (err) {
          return `{${(err as Error).message}}`;
        }
      })
      .join('');
}

/** `count`, `>= count`, `== count`, `% count`: DAP's hit-condition grammar. */
export function compileHitCondition(text: string): (hits: number) => boolean {
  const m = /^\s*(==|>=|>|<=|<|%)?\s*(\d+)\s*$/.exec(text);
  if (!m) {
    throw new Error(`hit condition must look like '5', '>= 5' or '% 5'`);
  }
  const n = Number(m[2]);
  switch (m[1] ?? '>=') {
    case '==':
      return (h) => h === n;
    case '>':
      return (h) => h > n;
    case '<':
      return (h) => h < n;
    case '<=':
      return (h) => h <= n;
    case '%':
      return (h) => n > 0 && h % n === 0;
    default:
      return (h) => h >= n;
  }
}
