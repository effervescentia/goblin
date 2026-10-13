/**
 * Goblin — minimal TypeScript engine for `.yaml` documents.
 *
 * Implements SYNTAX.md addressability plus the expression / patch
 * conventions observed in `main.yaml`, `player.yaml` and `monk*.yaml`:
 *
 * - Sigils: `.` current node, `$` document root, `@` actor root, `#` app root.
 * - Expressions: any string containing a sigil reference (or inline dice
 *   mixed with operators) is evaluated lazily with on-demand resolution.
 * - Dice: standalone `d6` / `2d6` produces a Die spec; inline dice rolls.
 * - Functions: keys like `roll()` or `ability_modifier(x)` define callables.
 * - Patches: quoted path keys (`'@.features'`), `+additions`, `$if`/`$then`
 *   conditions, `:meta` passthrough, `!validate` predicates, numeric level
 *   blocks (`1:`, `2:` …) applied in order.
 */

import {
  ACTOR,
  APP,
  CURRENT,
  DIE_LITERAL,
  DOCUMENT,
  IF_KEY,
  PARAM_KEY,
  TEMPLATE_CALL,
  TEMPLATE_SCAN,
  THEN_KEY,
  TYPE_KEY,
  VALIDATE_KEY,
  VALUE_KEY,
  VALUE_SLOT,
} from './constants';
import { FunctionNode } from './nodes/function';
import { parse } from './nodes/parse';
import {
  checkParamType,
  collectParams,
  compileBody,
  Die,
  deepClone,
  type EvalRoots,
  getChild,
  getChildEntry,
  getPath,
  isBareSigil,
  isExpressionString,
  isMetaKey,
  isParamRecord,
  isPathKey,
  isValidateKey,
  isValueRecord,
  joinPath,
  MATH_LIB,
  type MissingParam,
  materializeParams,
  parentOf,
  parseDie,
  parseRef,
  type ResolveHooks,
  serialize,
  setPath,
  stripPlus,
} from './utils';

export class GoblinEngine {
  /** Raw (unevaluated) documents by file name. */
  readonly docs = new Map<string, unknown>();
  /** `#` — shared global namespace (cross-doc values). */
  readonly appRoot: Record<string, unknown> = {};
  /** `$lib` — standard library: native math bound in code, yaml helpers merged on load. */
  readonly library: Record<string, unknown> = {
    math: { ...MATH_LIB },
  };
  /** Resolved-value cache + cycle guard for lazy references. */
  private readonly cache = new Map<string, unknown>();
  private readonly resolving: string[] = [];
  private readonly objIds = new WeakMap<object, number>();
  private nextId = 1;
  private libLoaded = false;

  constructor(private readonly rootDir = '.') {}

  async loadFile(file: string): Promise<unknown> {
    await this.ensureLib();
    const { YAML } = await import('bun');
    const text = await Bun.file(joinPath(this.rootDir, file)).text();
    const data = YAML.parse(text);
    this.register(file, data);
    await this.discoverTemplates(file, text);
    return data;
  }

  /** Merge a parsed library document over the native defaults. */
  mergeLib(data: unknown): void {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const record = data as Record<string, unknown>;
    Object.assign(this.library, record);
    this.library.math = { ...((record.math as Record<string, unknown> | undefined) ?? {}), ...MATH_LIB };
  }

  /**
   * Implicitly load the stdlib document living next to the engine module
   * (`src/lib.yaml`). Missing files are normal (tests seed documents
   * directly) — the in-code natives stand alone.
   */
  private async ensureLib(): Promise<void> {
    if (this.libLoaded) return;
    this.libLoaded = true;
    try {
      const { YAML } = await import('bun');
      const text = await Bun.file(new URL('./lib.yaml', import.meta.url)).text();
      this.mergeLib(YAML.parse(text));
    } catch {
      /* no lib file — natives stand alone */
    }
  }

  /**
   * Follow `$tmpl('…')` references recursively so templates resolve without
   * manual preloading. References resolve relative to the referring file's
   * directory; results are keyed both as written (matching `evalExpr`
   * lookups) and by resolved path (deduping spellings). Each file is read at
   * most once, so cycles terminate. NOTE: the scan is textual — keep
   * `$tmpl('…')` shapes out of comments.
   */
  private async discoverTemplates(file: string, text: string): Promise<void> {
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    const pattern = TEMPLATE_SCAN;
    let match: RegExpExecArray | null;
    match = pattern.exec(text);
    while (match !== null) {
      const name = match[1]!;
      const path = dir ? `${dir}/${name}` : name;
      if (!this.docs.has(name) && !this.docs.has(path)) {
        const { YAML } = await import('bun');
        const depText = await Bun.file(joinPath(this.rootDir, path)).text();
        const depData = YAML.parse(depText);
        this.register(path, depData);
        this.register(name, depData);
        await this.discoverTemplates(path, depText);
      }
      match = pattern.exec(text);
    }
  }

  /** Store a document under `file`, merging top-level tables into `#`. */
  register(file: string, data: unknown): unknown {
    this.docs.set(file, data);
    // Merge top-level `utils`/`math`-style tables into the app namespace
    // so `#.utils.…` works for self-contained docs like main.yaml.
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        if (!(k in this.appRoot)) this.appRoot[k] = deepClone(v);
      }
    }
    return data;
  }

  /** `$tmpl('other.yaml')` helper + any registered template loader. */
  async loadTemplate(file: string): Promise<unknown> {
    if (!this.docs.has(file)) await this.loadFile(file);
    return this.docs.get(file);
  }

  // -- reference resolution -------------------------------------------------

  private idOf(obj: unknown): string {
    if (obj === null || typeof obj !== 'object') return String(obj);
    let id = this.objIds.get(obj);
    if (id === undefined) {
      id = this.nextId++;
      this.objIds.set(obj, id);
    }
    return `obj${id}`;
  }

  private cacheKey(ref: string, scope: EvalRoots): string {
    return `${this.idOf(scope.doc)}|${this.idOf(scope.actor)}|${this.idOf(scope.current)}|${ref}`;
  }

  /** Wrap a raw `name(params)` function-definition entry in a callable. */
  private entryCallable(
    found: { parent: Record<string, unknown>; key: string; value: unknown },
    scope: EvalRoots,
  ): ((...args: unknown[]) => unknown) | undefined {
    const fn = FunctionNode.match(found.key, found.value, found.parent);
    if (!fn) return undefined;
    return fn.evaluate(this, scope) as ((...args: unknown[]) => unknown) | undefined;
  }

  resolveRef(ref: string, scope: EvalRoots): unknown {
    const { root, path } = parseRef(ref);
    let base =
      root === CURRENT ? scope.current : root === DOCUMENT ? scope.doc : root === ACTOR ? scope.actor : scope.app;
    let segments = path;
    // `$lib.…` addresses the standard library, unless the base document
    // defines its own `lib` table (explicit bindings win).
    if (segments[0] === 'lib' && (base == null || typeof base !== 'object' || getChild(base, 'lib') === undefined)) {
      base = this.library;
      segments = segments.slice(1);
    }

    if (segments.length === 0) {
      // A bare read of a value node yields its slot (`.` in `!validate`
      // rules reads the value under test); everything else evaluates as-is.
      if (isValueRecord(base)) {
        return this.evaluate((base as Record<string, unknown>)[VALUE_SLOT], { ...scope, current: base });
      }
      return this.evaluate(base, scope);
    }

    const key = this.cacheKey(ref, scope);
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.resolving.includes(key)) {
      throw new Error(`circular reference: ${[...this.resolving, key].join(' -> ')}`);
    }
    this.resolving.push(key);
    try {
      // Scope-aware walk with function-key awareness, so `ability_modifier`
      // finds the raw `ability_modifier(x)` entry. Intermediate expression
      // strings (e.g. a `$tmpl('…')` table) evaluate on the way down, with
      // `.` bound to their enclosing record.
      const found = this.walkScoped(base, segments, scope);
      if (found !== null) {
        const fn = this.entryCallable(found, scope);
        if (fn !== undefined) return fn;
      }
      const rawTarget = this.derefParam(found?.value, scope);
      if (rawTarget === undefined) {
        // Cross-namespace fallback into shared globals: `$`/`@` fall back
        // to the app root (e.g. `player.yaml` uses `@.utils.…` supplied by
        // the app), `#` falls back to the current document.
        const fallbackRoot = root === APP ? scope.doc : scope.app;
        const fallbackFound = this.walkScoped(fallbackRoot, segments, scope);
        if (fallbackFound !== null) {
          const fn = this.entryCallable(fallbackFound, scope);
          if (fn !== undefined) return fn;
          return this.evaluate(this.derefParam(fallbackFound.value, scope), scope);
        }
        return undefined;
      }
      const value = this.evaluate(rawTarget, {
        ...scope,
        current: parentOf(base, segments) ?? scope.current,
      });
      this.cache.set(key, value);
      return value;
    } finally {
      this.resolving.pop();
    }
  }

  /**
   * Value nodes dereference to their slot, so a bare `@.hit_points` reads
   * the filled value: `:param` records read their materialized `value` slot
   * (provided, default, or `null`), `:value` records evaluate their slot in
   * place. Anything else passes through untouched.
   */
  private derefParam(rawTarget: unknown, scope: EvalRoots): unknown {
    if (isParamRecord(rawTarget)) {
      const slot = rawTarget[VALUE_KEY];
      return slot !== undefined ? slot : null;
    }
    if (isValueRecord(rawTarget)) {
      const node = rawTarget as Record<string, unknown>;
      return this.evaluate(node[VALUE_SLOT], { ...scope, current: node });
    }
    return rawTarget;
  }

  /**
   * Like walkRaw, but expression strings met along the path evaluate first
   * so refs can descend through them (e.g. into a `$tmpl('…')` table).
   * Descending into a `:param` record's `value` slot is refused — read the
   * node bare instead. Terminates: re-entering the same ref hits the
   * resolving guard with a stabilized scope.
   */
  private walkScoped(
    base: unknown,
    path: string[],
    scope: EvalRoots,
  ): { parent: Record<string, unknown>; key: string; value: unknown } | null {
    let node: unknown = base;
    let parent: unknown = scope.current;
    let entry: { parent: Record<string, unknown>; key: string; value: unknown } | null = null;
    for (const seg of path) {
      if (typeof node === 'string' && node !== scope.current && isExpressionString(node)) {
        node = this.evaluate(node, { ...scope, current: parent });
      }
      if (seg === VALUE_KEY && isParamRecord(node)) return null;
      entry = getChildEntry(node, seg);
      if (entry === null) return null;
      parent = node;
      node = entry.value;
    }
    return entry;
  }

  private hooks(scope: EvalRoots): ResolveHooks {
    return {
      resolve: (ref: string) => {
        const value = this.resolveRef(ref, scope);
        if (value === undefined) throw new Error(`unresolvable reference: ${ref}`);
        return value;
      },
      assign: (ref: string, value: unknown) => {
        const { root, path } = parseRef(ref);
        const base =
          root === CURRENT ? scope.current : root === DOCUMENT ? scope.doc : root === ACTOR ? scope.actor : scope.app;
        // Assigning a value node writes its slot, preserving siblings.
        const target = path.length > 0 ? getPath(base, path) : undefined;
        if (isValueRecord(target)) {
          setPath(base as Record<string, unknown>, [...path, VALUE_SLOT], value);
        } else {
          setPath(base as Record<string, unknown>, path, value);
        }
        this.cache.clear();
        return value;
      },
    };
  }

  evalExpr(expr: string, scope: EvalRoots): unknown {
    const trimmed = expr.trim();
    const die = parseDie(trimmed);
    if (die && trimmed.match(DIE_LITERAL)) {
      // Standalone dice literal — return the spec, don't roll.
      if (trimmed === die.toString() || trimmed === `1d${die.sides}`.replace(/^1d/, 'd')) return die;
      return die;
    }
    // `$tmpl('file.yaml')` — synchronous template lookup (must be loaded).
    const tmpl = trimmed.match(TEMPLATE_CALL);
    if (tmpl) {
      const doc = this.docs.get(tmpl[1]!);
      if (doc === undefined) throw new Error(`template not loaded: ${tmpl[1]}`);
      return deepClone(doc);
    }
    const run = compileBody(trimmed, Object.keys(scope.params ?? {}));
    return run(this.hooks(scope), scope.params ?? {});
  }

  // -- deep evaluation ------------------------------------------------------

  /**
   * Recursively evaluate a raw subtree. `scope.current` is the nearest
   * enclosing record so `.sibling` resolves correctly; `scope.path` tracks
   * its dotted path so `:param` nodes can look up user-provided values.
   * Dispatches through `src/nodes` - one class per document node kind.
   */
  evaluate(raw: unknown, scope: EvalRoots): unknown {
    if (scope.path === undefined) {
      if (materializeParams(raw, scope.provided)) this.cache.clear();
      return this.evaluate(raw, { ...scope, path: [] });
    }
    return parse(raw).evaluate(this, scope);
  }

  /** Evaluate a whole loaded document as an actor (`$` and `@` coincide). */
  evaluateDoc(file: string, provided?: Record<string, unknown>): unknown {
    const raw = this.docs.get(file);
    if (raw === undefined) throw new Error(`document not loaded: ${file}`);
    if (materializeParams(raw, provided)) this.cache.clear();
    const scope: EvalRoots = {
      doc: raw,
      actor: raw,
      app: this.appRoot,
      current: raw,
      path: [],
      provided,
    };
    return this.evaluate(raw, scope);
  }

  /**
   * Report every `:param` node in a loaded document as `[{ path, doc? }]`
   * — paths needing user-provided values plus each node's attached `:doc`.
   */
  missingParams(file: string): MissingParam[] {
    const raw = this.docs.get(file);
    if (raw === undefined) throw new Error(`document not loaded: ${file}`);
    return collectParams(raw);
  }

  /**
   * Write override values into the raw tree (`.`/`$`/`@` target the actor,
   * `#` targets the app; bare paths default to the actor). Overridden paths
   * are replaced wholesale — derivations never run and missing paths are
   * created — but a `:param` record keeps its `:type` contract. Mutates like
   * `apply`; re-load or re-resolve for a pristine tree.
   */
  applyOverrides(actorRaw: unknown, overrides: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(overrides)) {
      const normalized = /^[.@#$]/.test(key) ? key : `@.${key}`;
      const { root, path } = parseRef(normalized);
      if (path.length === 0) continue;
      const base = root === APP ? this.appRoot : actorRaw;
      if (base === null || typeof base !== 'object') continue;
      const existing = getPath(base, path);
      if (existing !== null && typeof existing === 'object' && PARAM_KEY in (existing as Record<string, unknown>)) {
        const type = (existing as Record<string, unknown>)[TYPE_KEY];
        if (typeof type === 'string' && type) checkParamType(type, value, path.join('.'));
      }
      setPath(base as Record<string, unknown>, path, deepClone(value));
    }
  }

  /**
   * Resolve a document against user-provided values (keyed by dotted path
   * or `:param` alias). Satisfied documents return `{ data }` with the
   * serialized result; otherwise `{ query }` holds only the outstanding
   * params. Provided values of the wrong `:type` still throw.
   */
  resolve(
    file: string,
    provided: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
  ): { data: unknown } | { query: MissingParam[] } {
    const raw = this.docs.get(file);
    if (raw === undefined) throw new Error(`document not loaded: ${file}`);
    return this.resolveRaw(raw, provided, overrides);
  }

  /**
   * Resolve an in-memory actor tree (e.g. composed from `actor`/`adopt`
   * entry keys): `{ data }` when `provided` satisfies all params, else
   * `{ query }` with only the outstanding ones. Overrides apply first.
   */
  resolveRaw(
    actorRaw: unknown,
    provided: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
  ): { data: unknown } | { query: MissingParam[] } {
    this.applyOverrides(actorRaw, overrides);
    const outstanding = collectParams(actorRaw).filter((param) => provided[param.path] === undefined);
    if (outstanding.length > 0) return { query: outstanding };
    const scope: EvalRoots = { doc: actorRaw, actor: actorRaw, app: this.appRoot, current: actorRaw, provided };
    return { data: serialize(this.evaluate(actorRaw, scope)) };
  }

  // -- patches (class files, levels, conditions) ----------------------------

  /**
   * Apply an applied-document (e.g. a class file) onto an actor's raw tree.
   * Leveling lives in the files: gate per-level content with `$if` on actor
   * state (e.g. `@.level >= 5`). Evaluate with provided values first so
   * conditions read materialized params.
   */
  apply(actorRaw: unknown, patchFile: string): unknown {
    const patch = this.docs.get(patchFile);
    if (patch === undefined) throw new Error(`patch document not loaded: ${patchFile}`);
    return this.applyRaw(actorRaw, patch);
  }

  /** Apply an in-memory patch (e.g. a `$tmpl('…')` clone) onto an actor. */
  applyRaw(actorRaw: unknown, patch: unknown): unknown {
    const scope: EvalRoots = {
      doc: patch,
      actor: actorRaw,
      app: this.appRoot,
      current: actorRaw,
    };
    this.applyNode(actorRaw, patch, scope);
    return actorRaw;
  }

  /**
   * A `$if` wrapper gates its whole node: false applies nothing (not even
   * `:meta`), so gated-out content leaves no residue. Missing or empty
   * `$if` (comment-only `null`) counts as unconditional.
   */
  private condPasses(value: Record<string, unknown>, scope: EvalRoots): boolean {
    if (!(IF_KEY in value)) return true;
    const rawCond = value[IF_KEY];
    return rawCond == null || rawCond === '' ? true : Boolean(this.evaluate(rawCond, scope));
  }

  private applyNode(actorRaw: unknown, patch: unknown, scope: EvalRoots): void {
    if (Array.isArray(patch)) {
      this.applyArray(actorRaw as unknown[], patch);
      return;
    }
    if (typeof patch !== 'object' || patch === null) return;
    const target = actorRaw as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (isBareSigil(key) || key === DOCUMENT) continue;
      if (isMetaKey(key) || isValidateKey(key)) {
        target[key] = deepClone(value);
        continue;
      }
      if (key === IF_KEY || key === THEN_KEY) continue; // handled by mergeInto
      this.mergeEntry(target, key, value, scope);
    }
  }

  private applyAtPath(pathKey: string, value: unknown, scope: EvalRoots): void {
    const { root, path } = parseRef(pathKey);
    const base =
      root === ACTOR ? scope.actor : root === DOCUMENT ? scope.doc : root === APP ? scope.app : scope.current;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!this.condPasses(value as Record<string, unknown>, scope)) return;
      let target = getPath(base, path);
      if (typeof target !== 'object' || target === null) {
        setPath(base, path, {});
        target = getPath(base, path);
      }
      this.mergeInto(target, value, { ...scope, current: target });
      return;
    }
    if (Array.isArray(value)) {
      let target = getPath(base, path);
      if (!Array.isArray(target)) {
        setPath(base, path, []);
        target = getPath(base, path);
      }
      this.applyArray(target as unknown[], value);
      return;
    }
    setPath(base, path, deepClone(value));
  }

  /**
   * Merge a patch object into an existing target record, honoring
   * `+` additions, nested path keys, `:meta`, `!validate` and the
   * `$if` / `$then` condition wrapper.
   */
  private mergeInto(target: unknown, value: unknown, scope: EvalRoots): void {
    if (Array.isArray(value)) {
      if (Array.isArray(target)) this.applyArray(target, value);
      return;
    }
    if (!value || typeof value !== 'object' || typeof target !== 'object' || target === null) return;
    const rec = value as Record<string, unknown>;
    const tgt = target as Record<string, unknown>;
    if (IF_KEY in rec || THEN_KEY in rec) {
      if (!this.condPasses(rec, scope)) return;
      if (THEN_KEY in rec) this.applyPatchObject(rec[THEN_KEY], scope);
      for (const [k, v] of Object.entries(rec)) {
        if (k === IF_KEY || k === THEN_KEY) continue;
        this.mergeEntry(tgt, k, v, scope);
      }
      return;
    }
    for (const [k, v] of Object.entries(rec)) {
      this.mergeEntry(tgt, k, v, scope);
    }
  }

  /** A `$then` block is itself a patch: path keys are absolute. */
  private applyPatchObject(patch: unknown, scope: EvalRoots): void {
    if (Array.isArray(patch)) return;
    if (!patch || typeof patch !== 'object') return;
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (isBareSigil(k) || k === DOCUMENT || k === IF_KEY || k === THEN_KEY) continue;
      if (isMetaKey(k) || isValidateKey(k)) continue;
      if (isPathKey(k)) {
        this.applyAtPath(k, v, scope);
        continue;
      }
      this.mergeEntry(scope.actor as Record<string, unknown>, k, v, scope);
    }
  }

  private mergeEntry(target: Record<string, unknown>, key: string, value: unknown, scope: EvalRoots): void {
    if (isMetaKey(key) || isValidateKey(key)) {
      target[key] = deepClone(value);
      return;
    }
    if (isPathKey(key)) {
      this.applyAtPath(key, value, scope);
      return;
    }
    const k = stripPlus(key);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!this.condPasses(value as Record<string, unknown>, scope)) return;
      // Always merge through mergeInto so nested `+`, path keys and
      // `$if`/`$then` wrappers are consumed rather than stored raw.
      if (typeof target[k] !== 'object' || target[k] === null || Array.isArray(target[k])) {
        target[k] = {};
      }
      this.mergeInto(target[k], value, { ...scope, current: target[k] });
      return;
    }
    if (Array.isArray(value)) {
      if (!Array.isArray(target[k])) target[k] = [];
      this.applyArray(target[k] as unknown[], value);
      return;
    }
    target[k] = deepClone(value);
  }

  /** Array patch: `+item` entries append (deduped), others append raw. */
  private applyArray(target: unknown[], items: unknown[]): void {
    for (const item of items) {
      if (typeof item === 'string' && item.startsWith('+')) {
        const name = item.slice(1);
        if (!target.includes(name)) target.push(name);
      } else {
        target.push(deepClone(item));
      }
    }
  }

  // -- validation ------------------------------------------------------------

  /** Evaluate every `!validate` predicate list; return failure messages. */
  validate(evaluated: unknown): string[] {
    const failures: string[] = [];
    const visit = (node: unknown, rawScope: EvalRoots) => {
      if (Array.isArray(node)) {
        node.forEach((item) => visit(item, rawScope));
        return;
      }
      if (node && typeof node === 'object' && !(node instanceof Die)) {
        const rec = node as Record<string, unknown>;
        // Functions serialize as callables — skip.
        for (const [k, v] of Object.entries(rec)) {
          if (typeof v === 'function' || k === VALIDATE_KEY) continue;
          visit(v, rawScope);
        }
        const rules = rec[VALIDATE_KEY];
        if (Array.isArray(rules)) {
          for (const rule of rules) {
            if (typeof rule !== 'string') continue;
            let ok = false;
            try {
              ok = Boolean(
                this.evalExpr(rule, {
                  doc: this.appRoot,
                  actor: this.appRoot,
                  app: this.appRoot,
                  current: node,
                }),
              );
            } catch (err) {
              failures.push(`${String(rule)} → ${(err as Error).message}`);
              continue;
            }
            if (!ok) failures.push(String(rule));
          }
        }
      }
    };
    visit(evaluated, {
      doc: this.appRoot,
      actor: this.appRoot,
      app: this.appRoot,
      current: evaluated,
    });
    return failures;
  }
}
