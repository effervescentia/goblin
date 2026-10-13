/**
 * Goblin — pure utilities for `.yaml` documents.
 *
 * Engine-independent helpers shared by `engine.ts`, `cli.ts`, and tests:
 * dice, reference parsing, expression compilation, path access, and the
 * JSON-friendly serializer. Nothing here may import from `engine.ts`.
 */

import {
  ACTOR,
  APP,
  ASSIGN_OP,
  CURRENT,
  DEFAULT_KEY,
  DEPS_KEY,
  DIE_LITERAL,
  DOC_KEY,
  DOCUMENT,
  DOTLESS_SIGIL,
  FUNCTION_KEY,
  IF_KEY,
  INLINE_DICE,
  META_PREFIX,
  PARAM_KEY,
  PARAM_VALUE_KEY,
  PARAMS_KEY,
  SIGIL_REF,
  type Sigil,
  SOURCE_KEY,
  STRING_LITERAL,
  THEN_KEY,
  TYPE_KEY,
  VALIDATE_KEY,
  VALUE_KEY,
} from './constants';

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
  /** Dotted path of `current` in the evaluated output (drives `:param` lookup). */
  path?: string[];
  /** User-provided values for `:param` nodes, keyed by dotted path or alias. */
  provided?: Record<string, unknown>;
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
  return key.startsWith(META_PREFIX);
}

/** `!validate` / `'!validate'` predicate list. */
export function isValidateKey(key: string): boolean {
  return key === VALIDATE_KEY;
}

export function isFunctionKey(key: string): boolean {
  return FUNCTION_KEY.test(key);
}

/** Quoted or bare path patch, e.g. `@.features`, `#.hit_points.value`. */
export function isPathKey(key: string): boolean {
  const head = key[0];
  return head === CURRENT || head === DOCUMENT || head === ACTOR || head === APP;
}

/** Bare sigil (`$`, `@`, `#`, `.`) — a type annotation, not data. */
export function isBareSigil(key: string): boolean {
  return key.length === 1 && (key === CURRENT || key === DOCUMENT || key === ACTOR || key === APP);
}

export function isExpressionString(s: string): boolean {
  if (isDieLiteral(s)) return true;
  SIGIL_REF.lastIndex = 0;
  return SIGIL_REF.test(s);
}

export interface ParsedRef {
  root: Sigil;
  path: string[];
}

/** Normalize `$math.min` → `$.math.min`, split into root + segments. */
export function parseRef(ref: string): ParsedRef {
  const sigil = ref[0] as ParsedRef['root'];
  let rest = ref.slice(1);
  if (rest.length && !rest.startsWith(CURRENT)) rest = CURRENT + rest;
  if (rest.startsWith(CURRENT)) rest = rest.slice(1);
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
export function getChildEntry(
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

/** Join a root dir and file, collapsing `.`/`..` (Bun.file won't). */
export function joinPath(root: string, file: string): string {
  const out: string[] = [];
  for (const seg of `${root}/${file}`.split('/')) {
    if (seg === '' || seg === '.') {
      if (seg === '' && out.length === 0) out.push('');
      continue;
    }
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/') || '.';
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
    .replace(STRING_LITERAL, (m) => {
      literals.push(m);
      return `__STR${literals.length - 1}__`;
    })
    // Normalize dot-less sigils (`$math.min` → `$.math.min`).
    .replace(DOTLESS_SIGIL, '$1.');

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

export interface MissingParam {
  /** Dotted path of the node needing a value (`:param` alias when given). */
  path: string;
  /** The node's `:doc`, when attached. */
  doc?: string;
  /** The node's declared `:type`, when given. */
  type?: string;
}

/** A record declaring a user-provided value (`:param` marker present). */
export function isParamRecord(node: unknown): node is Record<string, unknown> {
  return typeof node === 'object' && node !== null && PARAM_KEY in node;
}

const PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'die', 'array', 'record'] as const;

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Die) return 'die';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Throw on undeclared type names. */
export function assertKnownParamType(type: string, path: string): void {
  if (!(PARAM_TYPES as readonly string[]).includes(type)) {
    throw new Error(`unknown param type: ${type} (at ${path})`);
  }
}

/** Throw on unknown types or provided values of the wrong type. */
export function checkParamType(type: string, value: unknown, path: string): void {
  assertKnownParamType(type, path);
  const ok =
    type === 'string'
      ? typeof value === 'string'
      : type === 'number'
        ? typeof value === 'number' && !Number.isNaN(value)
        : type === 'integer'
          ? typeof value === 'number' && Number.isInteger(value)
          : type === 'boolean'
            ? typeof value === 'boolean'
            : type === 'die'
              ? value instanceof Die
              : type === 'array'
                ? Array.isArray(value)
                : typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!ok) throw new Error(`param type mismatch: ${path} expected ${type}, got ${describeValue(value)}`);
}

/**
 * Structural walk collecting every `:param` record as `{ path, doc?, type? }`
 * per node needing a user-provided value. Patch instructions (`@.…` keys) are
 * not descended — params belong in actor-defining (or merged) trees.
 */
function eachParamRecord(raw: unknown, visit: (record: Record<string, unknown>, key: string) => void): void {
  const visitNode = (node: unknown, path: string[]) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visitNode(item, [...path, String(index)]));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const marker = record[PARAM_KEY];
    if (marker) visit(record, typeof marker === 'string' && marker ? marker : path.join('.'));
    for (const [key, value] of Object.entries(record)) {
      if (
        key === PARAM_KEY ||
        key === DOC_KEY ||
        key === TYPE_KEY ||
        key === VALIDATE_KEY ||
        key === IF_KEY ||
        key === THEN_KEY
      )
        continue;
      if (isBareSigil(key) || key === DOCUMENT || isPathKey(key)) continue;
      const fnMatch = key.match(FUNCTION_KEY);
      visitNode(value, [...path, fnMatch ? fnMatch[1]! : stripPlus(key)]);
    }
  };
  visitNode(raw, []);
}

export function collectParams(raw: unknown): MissingParam[] {
  const missing: MissingParam[] = [];
  eachParamRecord(raw, (record, key) => {
    const def = record[DEFAULT_KEY];
    if (def !== undefined && def !== null) return; // satisfied by default
    const doc = record[DOC_KEY];
    const entry: MissingParam = typeof doc === 'string' && doc ? { path: key, doc } : { path: key };
    const type = record[TYPE_KEY];
    if (typeof type === 'string' && type) {
      assertKnownParamType(type, key);
      entry.type = type;
    }
    missing.push(entry);
  });
  return missing;
}

/**
 * Fill raw `:param` records with `value` slots (provided, else `:default`,
 * else `null`) so `<path>.value` references resolve like any other node.
 * Returns true when anything was written. Idempotent.
 */
export function materializeParams(raw: unknown, provided: Record<string, unknown> = {}): boolean {
  let wrote = false;
  eachParamRecord(raw, (record, key) => {
    const def = record[DEFAULT_KEY];
    const hasDefault = def !== undefined && def !== null;
    record[VALUE_KEY] = provided[key] !== undefined ? provided[key] : hasDefault ? def : null;
    wrote = true;
  });
  return wrote;
}

/** Metadata attached to engine-created function closures for printing. */
export interface GoblinFunctionMeta {
  name: string;
  params: string[];
  /** The raw body string from the document. */
  source: string;
  /** Sigil refs the body resolves, in order of first appearance. */
  deps: string[];
}

/** Tag a closure with its document metadata. Survives as `$goblin`. */
export function tagFunction(
  fn: (...args: unknown[]) => unknown,
  meta: GoblinFunctionMeta,
): (...args: unknown[]) => unknown {
  (fn as unknown as Record<string, unknown>).$goblin = meta;
  return fn;
}

/** Read back `$goblin` metadata, if present. */
export function functionMeta(value: unknown): GoblinFunctionMeta | undefined {
  if (typeof value !== 'function') return undefined;
  const meta = (value as unknown as Record<string, unknown>).$goblin;
  return typeof meta === 'object' && meta !== null ? (meta as GoblinFunctionMeta) : undefined;
}

/**
 * Detect a body's reference dependencies: sigil refs outside string
 * literals, dot-less sigils normalized, deduplicated in order.
 */
export function detectDeps(body: string): string[] {
  const code = body.replace(STRING_LITERAL, '').replace(DOTLESS_SIGIL, '$1.');
  SIGIL_REF.lastIndex = 0;
  const matches = code.match(SIGIL_REF) ?? [];
  SIGIL_REF.lastIndex = 0;
  return [...new Set(matches)];
}
/** JSON-friendly serializer: Dice → `"d6"`, functions → `{ :type, :params, :source, :deps }`. */
export function serialize(value: unknown): unknown {
  if (value instanceof Die) return value.toString();
  if (typeof value === 'function') {
    const meta = functionMeta(value);
    if (meta)
      return {
        [TYPE_KEY]: 'function',
        [PARAMS_KEY]: meta.params,
        [SOURCE_KEY]: meta.source.trim(),
        [DEPS_KEY]: meta.deps,
      };
    const name = (value as { name?: unknown }).name;
    return `[fn ${typeof name === 'string' && name ? name : 'anonymous'}()]`;
  }
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serialize(v)]));
  }
  return value;
}

/**
 * Recursively drop metadata keys (`:…` and `!validate`) from resolved
 * output. `:param` records collapse to their `:value`; serialized functions
 * (`{ :type: 'function', :source, … }`) print as their source expression;
 * other records left empty (e.g. `{ :doc }`) collapse to `null`. Arrays are
 * mapped item-wise; scalars pass through.
 */
export function stripMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMetadata);
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (isParamRecord(rec)) {
      return stripMetadata(rec[PARAM_VALUE_KEY] ?? null);
    }
    if (rec[TYPE_KEY] === 'function' && typeof rec[SOURCE_KEY] === 'string') {
      return rec[SOURCE_KEY];
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (isMetaKey(k) || isValidateKey(k)) continue;
      out[k] = stripMetadata(v);
    }
    return Object.keys(out).length === 0 ? null : out;
  }
  return value;
}
