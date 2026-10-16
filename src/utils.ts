/** Goblin — refs, paths, and expression compilation. Node-specific helpers
 * live on their node class in `./nodes`; nothing here imports `engine.ts`. */

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
  WILDCARD,
} from './constants';
import type { InputEvent } from './inputs';
import type { Location } from './locations';
import { Die } from './nodes/die';

export interface EvalRoots {
  /** `#` — top of the current document. */
  doc: unknown;
  /** `@` — the actor instance the document is applied to. */
  actor: unknown;
  /** `$` — global application namespace. */
  app: unknown;
  /** `.` — nearest enclosing record of the expression. */
  current: unknown;
  /** Function call arguments, e.g. `x` in `ability_modifier(x)`. */
  params?: Record<string, unknown>;
  /** Dotted path of `current` in the evaluated output (drives `:param` lookup). */
  path?: string[];
  /** `--param` / `--set` events addressed relative to `actor` (params by dotted
   * path or alias); sets apply to each nested actor as expansion enters it. */
  inputs?: InputEvent[];
  /** Events led by an actor namespace (`aria.name`), read by whichever nested
   * actor holds that namespace. */
  namespaced?: InputEvent[];
  /** Document that wrote the expression being evaluated — the only one that
   * may reach `_` fields it wrote. */
  source?: string;
  /** Where that expression sits in its document, for the events it writes. */
  at?: Location;
  /** `#` for an expression written in another document than `doc` (a
   * definition's body, or a call's copy); unset, `#` is `doc`. */
  home?: unknown;
}

/** A `_` key is private to the document that wrote it. */
export function isPrivateKey(key: string): boolean {
  return key.startsWith('_');
}

/** Any `:`-prefixed key (`:doc`, …) is metadata: never evaluated. */
export function isMetaKey(key: string): boolean {
  return key.startsWith(META_PREFIX);
}

/** `!validate` / `'!validate'` predicate list. */
export function isValidateKey(key: string): boolean {
  return key === VALIDATE_KEY;
}

/** Path patch (`@.features`, `$.hit_points.value`); a leading `+` on the path
 * marks the write as an addition. */
export function isPathKey(key: string): boolean {
  const head = stripPlus(key)[0];
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
  return { root: sigil, path: splitPath(rest) };
}

/** Split a path on `.`, keeping a `{predicate}` segment whole. */
function splitPath(path: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let quote = '';
  let segment = '';
  for (const c of path) {
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"') quote = c;
    else if ('[({'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === '.' && depth === 0) {
      if (segment) segments.push(segment);
      segment = '';
      continue;
    }
    segment += c;
  }
  if (segment) segments.push(segment);
  return segments;
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
  // Wildcard segments become names, so refs carrying them match whole.
  const { code: marked, unmark } = markWildcards(protected_, literals);

  const assignIdx = marked.search(ASSIGN_OP);
  if (assignIdx >= 0) {
    let lhs = marked.slice(0, assignIdx).trim();
    const rhs = marked.slice(assignIdx + 1).trim();
    // `+=` / `-=` add to or take from what the target holds.
    const compound = lhs.match(/[+-]$/)?.[0];
    if (compound) lhs = lhs.slice(0, -1).trim();
    const op = JSON.stringify(compound ?? '=');
    SIGIL_REF.lastIndex = 0;
    if (SIGIL_REF.test(lhs) && lhs.replace(SIGIL_REF, '').trim() === '') {
      // A wildcard target assigns each match, evaluating the right side per
      // match — so it travels as text, not as one computed value.
      if (unmark(lhs) !== lhs) {
        const text = restoreLiterals(unmark(rhs), literals);
        return {
          code: `__assign_each(${JSON.stringify(unmark(lhs))}, ${JSON.stringify(text)}, ${op})`,
          isAssign: true,
        };
      }
      const code = `__assign(${JSON.stringify(lhs)}, (${rewriteExpr(rewriteIndexing(rhs), unmark)}), ${op})`;
      return { code: restoreLiterals(code, literals), isAssign: true };
    }
  }
  return { code: restoreLiterals(rewriteExpr(rewriteIndexing(marked), unmark), literals), isAssign: false };
}

function rewriteExpr(code: string, unmark: (ref: string) => string): string {
  SIGIL_REF.lastIndex = 0;
  return code
    .replace(INLINE_DICE, (_m, count: string, sides: string) => {
      const n = count || '1';
      return `__roll(${n}, ${sides})`;
    })
    .replace(SIGIL_REF, (m) => `__resolve(${JSON.stringify(unmark(m))})`);
}

/**
 * Swap wildcard segments (`.*`, `.{predicate}`) for placeholder names while
 * refs are matched — `*` alone reads as multiplication, `{` as an object.
 * `unmark` puts them back, predicates with their string `literals` restored.
 */
export function markWildcards(
  code: string,
  literals: string[] = [],
): { code: string; unmark: (text: string) => string } {
  const predicates: string[] = [];
  let out = '';
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '.' && code[i + 1] === '{') {
      const close = matchBracket(code, i + 1, 1);
      predicates.push(restoreLiterals(code.slice(i + 2, close), literals));
      out += `.__each${predicates.length}__`;
      i = close;
    } else if (code[i] === '.' && code[i + 1] === WILDCARD && /^$|[.\s),\]]/.test(code.charAt(i + 2))) {
      out += '.__each__';
      i += 1;
    } else {
      out += code.charAt(i);
    }
  }
  const unmark = (text: string) =>
    text.replace(/\.__each(\d*)__/g, (_m, n: string) => (n ? `.{${predicates[Number(n) - 1]}}` : `.${WILDCARD}`));
  return { code: out, unmark };
}

/** A path segment's wildcard form: `*` matches every child, `{predicate}`
 * those the predicate holds for; null for an ordinary segment. */
export function parseWildcard(segment: string): { predicate?: string } | null {
  if (segment === WILDCARD) return {};
  if (segment.startsWith('{') && segment.endsWith('}')) return { predicate: segment.slice(1, -1) };
  return null;
}

/** `x[i]` → `__index(x, i)`, leftmost first so chains (`x[0][1]`) nest. A `[`
 * right after `)`, `]` or a name indexes; anywhere else it opens a list. */
function rewriteIndexing(code: string): string {
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '[' || !/[\w)\]]/.test(code[i - 1] ?? '')) continue;
    const close = matchBracket(code, i, 1);
    const start = operandStart(code, i - 1);
    const inner = rewriteIndexing(code.slice(i + 1, close));
    const rewritten = `__index(${code.slice(start, i)}, ${inner})`;
    return rewriteIndexing(code.slice(0, start) + rewritten + code.slice(close + 1));
  }
  return code;
}

/** Index of the bracket pairing with `code[at]`, scanning in `step` direction. */
function matchBracket(code: string, at: number, step: 1 | -1): number {
  let depth = 0;
  for (let i = at; i >= 0 && i < code.length; i += step) {
    const c = code.charAt(i);
    if ('([{'.includes(c)) depth += step;
    else if (')]}'.includes(c)) depth -= step;
    if (depth === 0) return i;
  }
  throw new Error(`unbalanced brackets in expression: ${code}`);
}

/** Where the operand ending at `end` starts: a call with its name, a list, or a name. */
function operandStart(code: string, end: number): number {
  let i = end;
  if (code[i] === ')' || code[i] === ']') i = matchBracket(code, i, -1);
  else i += 1;
  while (i > 0 && /[\w.$@#]/.test(code.charAt(i - 1))) i--;
  return i;
}

function restoreLiterals(code: string, literals: string[]): string {
  return code.replace(/__STR(\d+)__/g, (_m, i: string) => literals[Number(i)]!);
}

/** `list[index]`: from 0, negative from the end, null past either end. */
function indexList(list: unknown, index: unknown): unknown {
  if (!Array.isArray(list)) throw new Error(`cannot index ${list === null ? 'null' : typeof list}: not a list`);
  if (typeof index !== 'number' || !Number.isInteger(index)) {
    throw new Error(`list index must be an integer, got ${String(index)}`);
  }
  return list.at(index) ?? null;
}

/** How an assignment writes: `=` replaces, `+` adds, `-` takes away. */
export type AssignOp = '=' | '+' | '-';

export interface ResolveHooks {
  resolve: (ref: string) => unknown;
  assign: (ref: string, value: unknown, op: AssignOp) => unknown;
  /** Assign every match of a wildcard ref, evaluating `expr` with `.` bound to each match's record. */
  assignEach: (ref: string, expr: string, op: AssignOp) => void;
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

  // No stdlib free variable is bound here: `$lib.…` is the only way in, so
  // `$math` stays an ordinary app ref that resolves to nothing.
  const fn = new Function('__resolve', '__assign', '__assign_each', '__roll', '__index', ...paramNames, js) as (
    ...args: unknown[]
  ) => unknown;

  return (hooks: ResolveHooks, params: Record<string, unknown> = {}) => {
    const roll = (count: number, sides: number) => Die.faces(count, sides).reduce((total, face) => total + face, 0);
    const args = [hooks.resolve, hooks.assign, hooks.assignEach, roll, indexList, ...paramNames.map((p) => params[p])];
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
