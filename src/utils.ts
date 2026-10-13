/**
 * Goblin — pure utilities for `.yaml` documents.
 *
 * Engine-independent helpers shared by `engine.ts`, `cli.ts`, and tests:
 * reference parsing, expression compilation, and path access. Node-specific
 * helpers live on their node class in `./nodes` (dice on `DieNode`, `:param`
 * records and metadata stripping on `RecordNode`, printing on each node's
 * `serialize`). Nothing here may import from `engine.ts`.
 */

import {
  ACTOR,
  APP,
  ASSIGN_OP,
  CURRENT,
  DOCUMENT,
  DOTLESS_SIGIL,
  FUNCTION_KEY,
  INLINE_DICE,
  META_PREFIX,
  SIGIL_REF,
  type Sigil,
  STRING_LITERAL,
  VALIDATE_KEY,
} from './constants';
import { Die } from './nodes/die';

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

/** Any `:`-prefixed key (`:doc`, …) is metadata: never evaluated. */
export function isMetaKey(key: string): boolean {
  return key.startsWith(META_PREFIX);
}

/** `!validate` / `'!validate'` predicate list. */
export function isValidateKey(key: string): boolean {
  return key === VALIDATE_KEY;
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

export interface ParsedRef {
  root: Sigil;
  path: string[];
}

/** Normalize `@abilities.strength` → `@.abilities.strength`, split into root + segments. */
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
  // Protect $lib refs so they aren't normalized to $.lib by DOTLESS_SIGIL.
  const libRefs: string[] = [];
  const libPlaceholder = (m: string) => {
    libRefs.push(m);
    return `__LIB${libRefs.length - 1}__`;
  };
  const protected_ = stmt
    .replace(STRING_LITERAL, (m) => {
      literals.push(m);
      return `__STR${literals.length - 1}__`;
    })
    // Protect $lib refs (must come before DOTLESS_SIGIL).
    .replace(/[$]lib(\.\w+)+/g, libPlaceholder)
    // Normalize dot-less sigils (`@abilities` → `@.abilities`).
    .replace(DOTLESS_SIGIL, '$1.')
    // Restore $lib refs.
    .replace(/__LIB(\d+)__/g, (_m, i: string) => libRefs[Number(i)]!);

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
  SIGIL_REF.lastIndex = 0;
  return code
    .replace(INLINE_DICE, (_m, count: string, sides: string) => {
      const n = count || '1';
      return `__roll(${n}, ${sides})`;
    })
    .replace(SIGIL_REF, (m) => `__resolve(${JSON.stringify(m)})`);
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

  // NOTE: no `math` (or other stdlib) free variable is bound here — the
  // standard library is reachable only through `$lib.…`, so `$math` / `$.math`
  // stay ordinary document refs that resolve to nothing.
  const fn = new Function('__resolve', '__assign', '__roll', ...paramNames, js) as (...args: unknown[]) => unknown;

  return (hooks: ResolveHooks, params: Record<string, unknown> = {}) => {
    const roll = (count: number, sides: number) => {
      let total = 0;
      for (let i = 0; i < count; i++) total += 1 + Math.floor(Math.random() * sides);
      return total;
    };
    const args = [hooks.resolve, hooks.assign, roll, ...paramNames.map((p) => params[p])];
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

/** Structural equality for raw document values (dice compare by spec text). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Die || b instanceof Die) return String(a) === String(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((k) => k in right && sameValue(left[k], right[k]));
  }
  return false;
}

export function stripPlus(key: string): string {
  return key.startsWith('+') ? key.slice(1) : key;
}
