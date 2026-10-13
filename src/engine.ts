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
  ADD_KEY,
  APP,
  CURRENT,
  DIE_LITERAL,
  DOCUMENT,
  IF_KEY,
  OVERRIDE_SOURCE,
  PARAM_KEY,
  PARAM_VALUE_KEY,
  SET_KEY,
  SOURCE_KEY,
  TEMPLATE_CALL,
  TEMPLATE_SCAN,
  THEN_KEY,
  TYPE_KEY,
  VALIDATE_KEY,
  VALUE_KEY,
} from './constants';
import { withNatives } from './lib';
import { Die, DieNode } from './nodes/die';
import { ExpressionNode } from './nodes/expression';
import { FunctionNode } from './nodes/function';
import { parse } from './nodes/parse';
import { type MissingParam, RecordNode } from './nodes/record';
import { serialize } from './nodes/serialize';
import {
  compileBody,
  deepClone,
  type EvalRoots,
  getChild,
  getChildEntry,
  getPath,
  isBareSigil,
  isMetaKey,
  isPathKey,
  isValidateKey,
  joinPath,
  parentOf,
  parseRef,
  type ResolveHooks,
  sameValue,
  setPath,
  stripPlus,
} from './utils';

export class GoblinEngine {
  /** Raw (unevaluated) documents by file name. */
  readonly docs = new Map<string, unknown>();
  /** `#` — shared global namespace (cross-doc values). */
  readonly appRoot: Record<string, unknown> = {};
  /** `$lib` — standard library: natives bound in code, yaml helpers merged on load. */
  readonly library: Record<string, unknown> = withNatives();
  /** Patch writes per field, keyed by the record holding the field. */
  private readonly fieldEvents = new WeakMap<object, Map<string, unknown[]>>();
  /** Source document of a raw tree: loaded documents and `$tmpl('…')` clones. */
  private readonly origins = new WeakMap<object, string>();
  /** Source names for the apply in progress (the patch, and the actor under it). */
  private applySource: string | undefined;
  private actorSource: string | undefined;
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

  /** Merge a parsed library document under the native defaults. */
  mergeLib(data: unknown): void {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    Object.assign(this.library, withNatives(data as Record<string, unknown>));
  }

  /**
   * Implicitly load the stdlib document shipped with the engine
   * (`src/lib/lib.yaml`). Missing files are normal (tests seed documents
   * directly) — the in-code natives stand alone.
   */
  private async ensureLib(): Promise<void> {
    if (this.libLoaded) return;
    this.libLoaded = true;
    try {
      const { YAML } = await import('bun');
      const text = await Bun.file(new URL('./lib/lib.yaml', import.meta.url)).text();
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
    // First spelling wins, so a template registered under both its path and
    // its bare name reports one stable source.
    if (data && typeof data === 'object' && !this.origins.has(data)) this.origins.set(data, file);
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
    // `$lib.…` addresses the standard library (only when written as $lib, not $.lib),
    // unless the base document defines its own `lib` table (explicit bindings win).
    const isLibShortcut = ref.startsWith('$lib') && !ref.startsWith('$.lib');
    if (
      isLibShortcut &&
      segments[0] === 'lib' &&
      (base == null || typeof base !== 'object' || getChild(base, 'lib') === undefined)
    ) {
      base = this.library;
      segments = segments.slice(1);
    }

    if (segments.length === 0) {
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
      const rawTarget = this.derefValue(found?.value);
      if (rawTarget === undefined) {
        // Cross-namespace fallback into shared globals: `$`/`@` fall back
        // to the app root (e.g. `player.yaml` uses `@.utils.…` supplied by
        // the app), `#` falls back to the current document.
        const fallbackRoot = root === APP ? scope.doc : scope.app;
        const fallbackFound = this.walkScoped(fallbackRoot, segments, scope);
        if (fallbackFound !== null) {
          const fn = this.entryCallable(fallbackFound, scope);
          if (fn !== undefined) return fn;
          return this.evaluate(this.derefValue(fallbackFound.value), scope);
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
   * Wrapper records dereference to the value they hold: a `:param` record to
   * its materialized `value` slot (so a bare `@.xp` reads the filled value —
   * provided, default, or `null`), a `{ :value, :events }` pair to its
   * `:value` (so refs into evaluated output, e.g. `!validate` predicates,
   * see through a field's history). Anything else passes through untouched.
   */
  private derefValue(rawTarget: unknown): unknown {
    if (RecordNode.isParam(rawTarget)) {
      const slot = rawTarget[VALUE_KEY];
      return slot !== undefined ? slot : null;
    }
    if (RecordNode.isEvented(rawTarget)) return rawTarget[PARAM_VALUE_KEY];
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
      if (typeof node === 'string' && node !== scope.current && ExpressionNode.matches(node)) {
        node = this.evaluate(node, { ...scope, current: parent });
      }
      if (seg === VALUE_KEY && RecordNode.isParam(node)) return null;
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
        setPath(base, path, value);
        this.cache.clear();
        return value;
      },
    };
  }

  evalExpr(expr: string, scope: EvalRoots): unknown {
    const trimmed = expr.trim();
    const die = DieNode.parse(trimmed);
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
      const clone = deepClone(doc);
      // The clone keeps the document's name so patch events can cite it.
      if (clone && typeof clone === 'object') this.origins.set(clone, tmpl[1]!);
      return clone;
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
      if (RecordNode.materializeParams(raw, scope.provided)) this.cache.clear();
      return this.evaluate(raw, { ...scope, path: [] });
    }
    return parse(raw).evaluate(this, scope);
  }

  /** Evaluate a whole loaded document as an actor (`$` and `@` coincide). */
  evaluateDoc(file: string, provided?: Record<string, unknown>): unknown {
    const raw = this.docs.get(file);
    if (raw === undefined) throw new Error(`document not loaded: ${file}`);
    if (RecordNode.materializeParams(raw, provided)) this.cache.clear();
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
    return RecordNode.collectParams(raw);
  }

  /**
   * Write override values into the raw tree (`.`/`$`/`@` target the actor,
   * `#` targets the app; bare paths default to the actor). Overridden paths
   * are replaced wholesale — derivations never run and missing paths are
   * created — but a `:param` record keeps its `:type` contract. Mutates like
   * `apply`; re-load or re-resolve for a pristine tree.
   *
   * Each value actually changed is filed as an `override` event, so a sheet
   * shows the explicit value beating whatever derived it. Overrides apply
   * both before and after the patches (explicit values always win), so a
   * re-application that writes the value already in place is not an event.
   */
  applyOverrides(actorRaw: unknown, overrides: Record<string, unknown>): void {
    this.asSource(OVERRIDE_SOURCE, actorRaw, () => {
      for (const [key, value] of Object.entries(overrides)) {
        const normalized = /^[.@#$]/.test(key) ? key : `@.${key}`;
        const { root, path } = parseRef(normalized);
        if (path.length === 0) continue;
        const base = root === APP ? this.appRoot : actorRaw;
        if (base === null || typeof base !== 'object') continue;
        const existing = getPath(base, path);
        if (existing !== null && typeof existing === 'object' && PARAM_KEY in (existing as Record<string, unknown>)) {
          const record = existing as Record<string, unknown>;
          const type = record[TYPE_KEY];
          if (typeof type === 'string' && type) RecordNode.checkParamType(type, value, path.join('.'));
          RecordNode.checkParamConstraints(record, value, path.join('.'));
        }
        const slot = this.ownerOf(base, path);
        if (slot && !sameValue(existing, value)) this.recordEvent(slot.owner, slot.key, SET_KEY, deepClone(value));
        setPath(base as Record<string, unknown>, path, deepClone(value));
      }
    });
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
    const outstanding = RecordNode.collectParams(actorRaw).filter((param) => provided[param.path] === undefined);
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
    return this.applyRaw(actorRaw, patch, patchFile);
  }

  /**
   * Apply an in-memory patch (e.g. a `$tmpl('…')` clone) onto an actor.
   * `source` names the patch in the fields' event logs; it defaults to the
   * document the tree came from, when the engine loaded it.
   */
  applyRaw(actorRaw: unknown, patch: unknown, source?: string): unknown {
    const scope: EvalRoots = {
      doc: patch,
      actor: actorRaw,
      app: this.appRoot,
      current: actorRaw,
    };
    this.asSource(source ?? this.sourceOf(patch), actorRaw, () => this.applyNode(actorRaw, patch, scope));
    return actorRaw;
  }

  // -- change events --------------------------------------------------------

  /** Run `write` with the event sources it should file writes under. */
  private asSource(source: string | undefined, actorRaw: unknown, write: () => void): void {
    const outerPatch = this.applySource;
    const outerActor = this.actorSource;
    this.applySource = source;
    this.actorSource = this.sourceOf(actorRaw);
    try {
      write();
    } finally {
      this.applySource = outerPatch;
      this.actorSource = outerActor;
    }
  }

  /** The document a raw tree came from, when it is one the engine loaded. */
  private sourceOf(raw: unknown): string | undefined {
    return raw && typeof raw === 'object' ? this.origins.get(raw) : undefined;
  }

  /** One `{ :source?, :set | :add }` entry. */
  private event(source: string | undefined, kind: string, value: unknown): Record<string, unknown> {
    return source === undefined ? { [kind]: value } : { [SOURCE_KEY]: source, [kind]: value };
  }

  /**
   * Note a patch write on `target[key]`, in application order. Call before
   * writing: the first event on a field that already holds a value records
   * that value first, so a history reads base-then-patch. Fields no patch
   * ever touched stay event-free, and print as bare values.
   */
  private recordEvent(target: Record<string, unknown>, key: string, kind: string, value: unknown): void {
    this.seedEvents(target, key).push(this.event(this.applySource, kind, value));
  }

  /**
   * Open `target[key]`'s log, recording the value it already holds as the
   * first event. Call before mutating in place (array appends), so the
   * origin event captures what was there rather than the result.
   */
  private seedEvents(target: Record<string, unknown>, key: string): unknown[] {
    let fields = this.fieldEvents.get(target);
    if (fields === undefined) {
      fields = new Map();
      this.fieldEvents.set(target, fields);
    }
    let log = fields.get(key);
    if (log === undefined) {
      log = key in target ? [this.event(this.actorSource, SET_KEY, deepClone(target[key]))] : [];
      fields.set(key, log);
    }
    return log;
  }

  /** The writes that produced `record[key]`, or undefined when untouched. */
  eventsFor(record: object, key: string): unknown[] | undefined {
    const log = this.fieldEvents.get(record)?.get(key);
    return log && log.length > 0 ? log : undefined;
  }

  /**
   * The record owning the last segment of `path` and the key within it,
   * creating intermediate records the way `setPath` does so an event can be
   * filed before the write lands.
   */
  private ownerOf(base: unknown, path: string[]): { owner: Record<string, unknown>; key: string } | null {
    const key = path.at(-1);
    if (key === undefined || base === null || typeof base !== 'object') return null;
    let node = base as Record<string, unknown>;
    for (const seg of path.slice(0, -1)) {
      if (typeof node[seg] !== 'object' || node[seg] === null) node[seg] = {};
      node = node[seg] as Record<string, unknown>;
    }
    return { owner: node, key };
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
      const slot = this.ownerOf(base, path);
      if (slot) this.seedEvents(slot.owner, slot.key); // before the append, not after
      let target = getPath(base, path);
      if (!Array.isArray(target)) {
        setPath(base, path, []);
        target = getPath(base, path);
      }
      const added = this.applyArray(target as unknown[], value);
      if (slot && added.length > 0) this.recordEvent(slot.owner, slot.key, ADD_KEY, added);
      return;
    }
    const slot = this.ownerOf(base, path);
    if (slot) this.recordEvent(slot.owner, slot.key, SET_KEY, deepClone(value));
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
      // A `+key` record (a feature, an action, a resource) is a change to the
      // key itself: its fields may be pure metadata, so without this the
      // addition would leave no trace. Scalar and array `+key` writes record
      // their own content below, and are not double-logged here.
      if (key !== k) this.recordEvent(target, k, ADD_KEY, k);
      // Always merge through mergeInto so nested `+`, path keys and
      // `$if`/`$then` wrappers are consumed rather than stored raw.
      if (typeof target[k] !== 'object' || target[k] === null || Array.isArray(target[k])) {
        target[k] = {};
      }
      this.mergeInto(target[k], value, { ...scope, current: target[k] });
      return;
    }
    if (Array.isArray(value)) {
      this.seedEvents(target, k); // before the append, not after
      if (!Array.isArray(target[k])) target[k] = [];
      const added = this.applyArray(target[k] as unknown[], value);
      if (added.length > 0) this.recordEvent(target, k, ADD_KEY, added);
      return;
    }
    this.recordEvent(target, k, SET_KEY, deepClone(value));
    target[k] = deepClone(value);
  }

  /**
   * Array patch: `+item` entries append (deduped), others append raw.
   * Returns what was actually appended, for the field's event log.
   */
  private applyArray(target: unknown[], items: unknown[]): unknown[] {
    const added: unknown[] = [];
    for (const item of items) {
      if (typeof item === 'string' && item.startsWith('+')) {
        const name = item.slice(1);
        if (!target.includes(name)) {
          target.push(name);
          added.push(name);
        }
      } else {
        const clone = deepClone(item);
        target.push(clone);
        added.push(clone);
      }
    }
    return added;
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
