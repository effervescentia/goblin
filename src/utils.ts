/**
 * Goblin — pure utilities for `.yaml` documents.
 *
 * Engine-independent helpers shared by `engine.ts`, `cli.ts`, and tests:
 * dice, reference parsing, expression compilation, path access, and the
 * JSON-friendly serializer. Nothing here may import from `engine.ts`.
 */

export interface EvalRoots {
  /** `$` — top of the current document. */
  doc: unknown;
  /** `@` — the actor instance the document is applied to. */
  actor: unknown;
  /** `#` — global application namespace. */
  app: unknown;
  /** `.` — nearest enclosing record of the expression. */
  current: unknown;
  /** Function call arguments, e.g. `x` in `ability_modifier(x)`. */
  params?: Record<string, unknown>;
}

export class Die {
  constructor(
    public readonly count: number,
    public readonly sides: number,
    private readonly label?: string,
  ) {}

  roll(): number {
    let total = 0;
    for (let i = 0; i < this.count; i++) {
      total += 1 + Math.floor(Math.random() * this.sides);
    }
    return total;
  }

  /** Arithmetic with a die rolls it (`hit_points + hit_die`). */
  valueOf(): number {
    return this.roll();
  }

  [Symbol.toPrimitive](hint: string): string | number {
    return hint === 'string' ? this.toString() : this.roll();
  }

  toString(): string {
    return this.label ?? `${this.count > 1 ? this.count : ''}d${this.sides}`;
  }
}

export const DIE_LITERAL = /^(\d*)d(\d+)$/;
const SIGIL_REF = /([#$@]\.[A-Za-z_][\w.]*|[#$@](?![\w.]|\.\w)|\.[A-Za-z_][\w.]*|\.(?![\w.]))/g;
const INLINE_DICE = /\b(\d*)d(\d+)\b/g;
export const FUNCTION_KEY = /^([A-Za-z_]\w*)\(([^)]*)\)$/;
const ASSIGN_OP = /(?<![<>=!])=(?![>=])/;

export const MATH_LIB: Record<string, (...args: number[]) => number> = {
  floor: (n: number) => Math.floor(n),
  ceil: (n: number) => Math.ceil(n),
  round: (n: number) => Math.round(n),
  abs: (n: number) => Math.abs(n),
  min: (...ns: number[]) => Math.min(...ns),
  max: (...ns: number[]) => Math.max(...ns),
};

export function isDieLiteral(s: string): boolean {
  return DIE_LITERAL.test(s.trim());
}

export function parseDie(s: string): Die | null {
  const m = s.trim().match(DIE_LITERAL);
  if (!m) return null;
  const count = m[1] ? Number(m[1]) : 1;
  return new Die(count, Number(m[2]), s.trim());
}

/** Any `:`-prefixed key (`:doc`, …) is metadata: never evaluated. */
export function isMetaKey(key: string): boolean {
  return key.startsWith(':');
}

/** `!validate` / `'!validate'` predicate list. */
export function isValidateKey(key: string): boolean {
  return key === '!validate';
}

export function isFunctionKey(key: string): boolean {
  return FUNCTION_KEY.test(key);
}

/** Quoted or bare path patch, e.g. `@.features`, `#.hit_points.value`. */
export function isPathKey(key: string): boolean {
  return /^[.@#$]/.test(key);
}

/** Bare sigil (`$`, `@`, `#`, `.`) — a type annotation, not data. */
export function isBareSigil(key: string): boolean {
  return /^[.@#$]$/.test(key);
}

export function isExpressionString(s: string): boolean {
  if (isDieLiteral(s)) return true;
  SIGIL_REF.lastIndex = 0;
  return SIGIL_REF.test(s);
}

export interface ParsedRef {
  root: '.' | '$' | '@' | '#';
  path: string[];
}

/** Normalize `$math.min` → `$.math.min`, split into root + segments. */
export function parseRef(ref: string): ParsedRef {
  const sigil = ref[0] as ParsedRef['root'];
  let rest = ref.slice(1);
  if (rest.length && !rest.startsWith('.')) rest = `.${rest}`;
  if (rest.startsWith('.')) rest = rest.slice(1);
  const path = rest ? rest.split('.').filter(Boolean) : [];
  return { root: sigil, path };
}

export function getPath(root: unknown, path: string[]): unknown {
  let node: unknown = root;
  for (const seg of path) {
    node = getChild(node, seg);
    if (node === undefined) return undefined;
  }
  return node;
}

/** Object child lookup that also matches function keys (`name(params)`). */
export function getChild(node: unknown, seg: string): unknown {
  if (node == null || typeof node !== 'object') return undefined;
  const rec = node as Record<string, unknown>;
  if (seg in rec) return rec[seg];
  const fnKey = Object.keys(rec).find((k) => {
    const m = k.match(FUNCTION_KEY);
    return m?.[1] === seg;
  });
  return fnKey !== undefined ? rec[fnKey] : undefined;
}

/** Like getChild but also returns the matched key and parent record. */
function getChildEntry(
  node: unknown,
  seg: string,
): { parent: Record<string, unknown>; key: string; value: unknown } | null {
  if (node == null || typeof node !== 'object') return null;
  const rec = node as Record<string, unknown>;
  if (seg in rec) return { parent: rec, key: seg, value: rec[seg] };
  const fnKey = Object.keys(rec).find((k) => k.match(FUNCTION_KEY)?.[1] === seg);
  if (fnKey !== undefined) return { parent: rec, key: fnKey, value: rec[fnKey] };
  return null;
}

export function setPath(root: unknown, path: string[], value: unknown): void {
  let node = root as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    if (typeof node[seg] !== 'object' || node[seg] == null) node[seg] = {};
    node = node[seg] as Record<string, unknown>;
  }
  node[path[path.length - 1]!] = value;
}

export function deepClone<T>(value: T): T {
  if (value instanceof Die) return new Die(value.count, value.sides) as T;
  if (typeof value === 'function') return value;
  if (Array.isArray(value)) return value.map(deepClone) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, deepClone(v)])) as T;
  }
  return value;
}

function splitStatements(body: string): string[] {
  return body
    .split(/\r?\n|;/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Transpile one goblin statement to JS. Assignments become `__assign` calls. */
function transpileStatement(stmt: string): { code: string; isAssign: boolean } {
  // Protect string literals from ref/dice rewriting.
  const literals: string[] = [];
  const protected_ = stmt
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, (m) => {
      literals.push(m);
      return `__STR${literals.length - 1}__`;
    })
    // Normalize dot-less sigils (`$math.min` → `$.math.min`).
    .replace(/([#$@])(?=[A-Za-z_])/g, '$1.');

  const assignIdx = protected_.search(ASSIGN_OP);
  if (assignIdx >= 0) {
    const lhs = protected_.slice(0, assignIdx).trim();
    const rhs = protected_.slice(assignIdx + 1).trim();
    SIGIL_REF.lastIndex = 0;
    if (SIGIL_REF.test(lhs) && lhs.replace(SIGIL_REF, '').trim() === '') {
      const code = `__assign(${JSON.stringify(lhs)}, (${rewriteExpr(rhs)}))`;
      return { code: restoreLiterals(code, literals), isAssign: true };
    }
  }
  return { code: restoreLiterals(rewriteExpr(protected_), literals), isAssign: false };
}

function rewriteExpr(code: string): string {
  const withDice = code.replace(INLINE_DICE, (_m, count: string, sides: string) => {
    const n = count || '1';
    return `__roll(${n}, ${sides})`;
  });
  SIGIL_REF.lastIndex = 0;
  return withDice.replace(SIGIL_REF, (m) => `__resolve(${JSON.stringify(m)})`);
}

function restoreLiterals(code: string, literals: string[]): string {
  return code.replace(/__STR(\d+)__/g, (_m, i: string) => literals[Number(i)]!);
}

export interface ResolveHooks {
  resolve: (ref: string) => unknown;
  assign: (ref: string, value: unknown) => unknown;
}

/**
 * Compile a goblin expression / statement block into a callable.
 * `paramNames` are function-definition parameters (e.g. `["x"]`).
 */
export function compileBody(body: string, paramNames: string[] = []) {
  const statements = splitStatements(body);
  const codes = statements.map((s) => transpileStatement(s));
  const hasAssign = codes.some((c) => c.isAssign);
  const js =
    codes.length > 1 || hasAssign
      ? `${codes
          .map((c, i) => (i === codes.length - 1 && !c.isAssign ? `return (${c.code});` : `${c.code};`))
          .join('\n')}`
      : `return (${codes[0]?.code ?? 'undefined'});`;

  const fn = new Function('__resolve', '__assign', '__roll', 'math', ...paramNames, js) as (
    ...args: unknown[]
  ) => unknown;

  return (hooks: ResolveHooks, params: Record<string, unknown> = {}) => {
    const roll = (count: number, sides: number) => {
      let total = 0;
      for (let i = 0; i < count; i++) total += 1 + Math.floor(Math.random() * sides);
      return total;
    };
    const args = [hooks.resolve, hooks.assign, roll, MATH_LIB, ...paramNames.map((p) => params[p])];
    return fn(...args);
  };
}

/** Walk a raw tree with function-key awareness; null when unresolvable. */
export function walkRaw(
  base: unknown,
  path: string[],
): { parent: Record<string, unknown>; key: string; value: unknown } | null {
  let node: unknown = base;
  let entry: { parent: Record<string, unknown>; key: string; value: unknown } | null = null;
  for (const seg of path) {
    entry = getChildEntry(node, seg);
    if (entry === null) return null;
    node = entry.value;
  }
  return entry;
}

export function parentOf(base: unknown, path: string[]): unknown {
  if (path.length <= 1) return base;
  return getPath(base, path.slice(0, -1));
}

export function stripPlus(key: string): string {
  return key.startsWith('+') ? key.slice(1) : key;
}

/** JSON-friendly serializer: Dice → `"d6"`, functions → `"[fn name()]"`. */
export function serialize(value: unknown): unknown {
  if (value instanceof Die) return value.toString();
  if (typeof value === 'function') return `[fn ${value.name || 'anonymous'}()]`;
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serialize(v)]));
  }
  return value;
}
