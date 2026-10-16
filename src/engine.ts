/**
 * Goblin — minimal TypeScript engine for `.yaml` documents.
 *
 * Implements SYNTAX.md addressability plus the expression / patch
 * conventions observed in `main.yaml`, `player.yaml` and `monk*.yaml`:
 *
 * - Sigils: `.` current node, `#` document root, `@` actor root, `$` app root.
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
  ACTOR_KEY,
  ADD_KEY,
  APP,
  CALL_EXPR,
  COLUMN_KEY,
  CURRENT,
  DIE_LITERAL,
  DOCUMENT,
  IF_KEY,
  LINE_KEY,
  MIXIN_CALL,
  OVERRIDE_SOURCE,
  PARAM_KEY,
  PARAM_VALUE_KEY,
  SET_KEY,
  SOURCE_KEY,
  SUBTRACT_KEY,
  TEMPLATE_CALL,
  TEMPLATE_SCAN,
  THEN_KEY,
  TYPE_KEY,
  VALIDATE_KEY,
  VALUE_KEY,
} from './constants';
import { withNatives } from './lib';
import { collectLocations, copyLocations, type Location, type Locations } from './locations';
import { Die, DieNode } from './nodes/die';
import { ExpressionNode } from './nodes/expression';
import { FunctionNode } from './nodes/function';
import { parse } from './nodes/parse';
import { type MissingParam, RecordNode } from './nodes/record';
import { debug } from './nodes/serialize';
import {
  type AssignOp,
  compileBody,
  deepClone,
  type EvalRoots,
  getChild,
  getChildEntry,
  getPath,
  isBareSigil,
  isMetaKey,
  isPathKey,
  isPrivateKey,
  isValidateKey,
  joinPath,
  parentOf,
  parseRef,
  parseWildcard,
  type ResolveHooks,
  sameValue,
  setPath,
  stripPlus,
} from './utils';

/** `+field` on a scalar: two numbers sum, anything else composes an
 * expression so an added expression stays lazy. */
function addRaw(existing: unknown, value: unknown, label: string): unknown {
  if (existing === undefined || existing === null) return deepClone(value);
  if (typeof existing === 'number' && typeof value === 'number') return existing + value;
  if (typeof existing === 'object' || typeof value === 'object') {
    throw new Error(`cannot add to ${label}: a record or list is not a value to add to`);
  }
  return `(${String(existing)}) + (${String(value)})`;
}

/** `+item` entries add, a plain list replaces; mixing the two readings in one
 * list is rejected rather than silently picking one. */
function isAdditiveList(items: unknown[], label = 'list'): boolean {
  const additions = items.filter((item) => typeof item === 'string' && item.startsWith('+'));
  if (additions.length > 0 && additions.length < items.length) {
    throw new Error(`mixed list patch: ${label} combines '+item' additions with plain items — use one or the other`);
  }
  return additions.length > 0;
}

export class GoblinEngine {
  /** Raw (unevaluated) documents by file name. */
  readonly docs = new Map<string, unknown>();
  /** `$` — shared global namespace (cross-doc values). */
  readonly appRoot: Record<string, unknown> = {};
  /** `$lib` — standard library: natives bound in code, yaml helpers merged on load. */
  readonly library: Record<string, unknown> = withNatives();
  /** Patch writes per field, keyed by the record holding the field. */
  private readonly fieldEvents = new WeakMap<object, Map<string, unknown[]>>();
  /** Source document of a raw tree: loaded documents and `$tmpl('…')` clones. */
  private readonly origins = new WeakMap<object, string>();
  /** The document a record call's copy was written in: its `#` wherever it lands. */
  private readonly homes = new WeakMap<object, unknown>();
  /** The document each `$tmpl` / `$mixin` clone was pulled in by: the
   * template chain a mixin walks up to find its actor. */
  private readonly parents = new WeakMap<object, unknown>();
  /** The actor each patch document is being applied to. */
  private readonly actorOf = new WeakMap<object, unknown>();
  /** Where each key was written in its source document. */
  private readonly locations: Locations = new WeakMap();
  /** Location of the patch key being applied; events cite it. */
  private writingAt: Location | undefined;
  /** Document that wrote each record and list, for `_` field visibility. */
  private readonly owners = new WeakMap<object, string>();
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
    this.register(file, data, text);
    await this.discoverTemplates(file, text);
    return data;
  }

  /** Merge a parsed library document under the native defaults. */
  mergeLib(data: unknown): void {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    Object.assign(this.library, withNatives(data as Record<string, unknown>));
  }

  /** Load the stdlib document shipped with the engine. A missing file is
   * normal (tests seed documents directly): the natives stand alone. */
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
    // `matchAll` scans a copy: the recursion below must not share `lastIndex`.
    for (const match of text.matchAll(TEMPLATE_SCAN)) {
      const name = match[1]!;
      const path = dir ? `${dir}/${name}` : name;
      if (!this.docs.has(name) && !this.docs.has(path)) {
        const { YAML } = await import('bun');
        const depText = await Bun.file(joinPath(this.rootDir, path)).text();
        const depData = YAML.parse(depText);
        this.register(path, depData, depText);
        this.register(name, depData);
        await this.discoverTemplates(path, depText);
      }
    }
  }

  /** Store a document under `file`, merging top-level tables into `$`. */
  register(file: string, data: unknown, text?: string): unknown {
    this.docs.set(file, data);
    if (text !== undefined && data !== null && typeof data === 'object' && !this.locations.has(data)) {
      collectLocations(text, data, this.locations);
    }
    // First spelling wins, so a template registered under both its path and
    // its bare name reports one stable source.
    if (data && typeof data === 'object' && !this.origins.has(data)) this.origins.set(data, file);
    this.claim(data, file);
    // Merge top-level `utils`/`math`-style tables into the app namespace
    // so `$.utils.…` works for self-contained docs like main.yaml.
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        // A document that is itself one node (a `$tmpl`'d `:param` record)
        // would otherwise bind its metadata as app-root tables.
        if (isMetaKey(k) || isValidateKey(k) || isBareSigil(k)) continue;
        if (!(k in this.appRoot)) this.appRoot[k] = this.claim(this.clone(v), file);
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
    return `${this.idOf(scope.doc)}|${this.idOf(scope.home)}|${this.idOf(scope.actor)}|${this.idOf(scope.current)}|${scope.source ?? ''}|${ref}`;
  }

  /** Wrap a raw `name(params)` function-definition entry in a callable. */
  private entryCallable(
    found: { parent: Record<string, unknown>; key: string; value: unknown },
    scope: EvalRoots,
  ): ((...args: unknown[]) => unknown) | undefined {
    const fn = FunctionNode.match(found.key, found.value, found.parent);
    if (!fn) return undefined;
    const source = this.fieldSource(found.parent, found.key);
    const at = this.locationOf(found.parent, found.key);
    const home = this.definedIn(found.parent, source, scope);
    return fn.evaluate(this, { ...scope, home, source, at }) as ((...args: unknown[]) => unknown) | undefined;
  }

  /** The `#` of a definition held by `parent`: the document that wrote it.
   * The caller's own (live) document wins when it is that document. */
  private definedIn(parent: object, source: string | undefined, scope: EvalRoots): unknown {
    const home = this.homes.get(parent);
    if (home !== undefined) return home;
    const doc = scope.home ?? scope.doc;
    const callerDoc = doc !== null && typeof doc === 'object' ? this.owners.get(doc) : undefined;
    if (source === undefined || source === callerDoc) return scope.home;
    return this.docs.get(source) ?? scope.home;
  }

  /** The tree a sigil reads from. */
  private rootFor(root: string, scope: EvalRoots): unknown {
    if (root === CURRENT) return scope.current;
    if (root === DOCUMENT) return scope.home ?? scope.doc;
    return root === ACTOR ? scope.actor : scope.app;
  }

  /** Mark a record call's copy as written in `doc`, so its `#` stays there. */
  settle<T>(tree: T, doc: unknown): T {
    const visit = (node: unknown) => {
      if (node === null || typeof node !== 'object' || node instanceof Die || this.homes.has(node)) return;
      this.homes.set(node, doc);
      for (const child of Object.values(node)) visit(child);
    };
    visit(tree);
    return tree;
  }

  resolveRef(ref: string, scope: EvalRoots): unknown {
    const { root, path } = parseRef(ref);
    let base = this.rootFor(root, scope);
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
    // A wildcard ref reads as the list of its matches that resolve.
    if (segments.some((segment) => parseWildcard(segment) !== null)) {
      return this.expandPaths(base, segments, scope)
        .map((path) => this.resolveRef(root === CURRENT ? `.${path.join('.')}` : `${root}.${path.join('.')}`, scope))
        .filter((value) => value !== undefined);
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
      // Every sigil names exactly one tree: a missing path never falls back.
      if (rawTarget === undefined) return undefined;
      const ownScope = {
        ...scope,
        source: found === null ? scope.source : this.fieldSource(found.parent, found.key),
        // The target reads `#` as its own document, not the reader's.
        home: found === null ? undefined : this.homes.get(found.parent),
        current: parentOf(base, segments) ?? scope.current,
        // The target's own path, so `:param` nodes inside it look up provided
        // values by where they live, not where the reference was written.
        path: root === CURRENT ? [...(scope.path ?? []), ...segments] : segments,
      };
      // A target inside a nested actor reads `#` and `@` as that actor.
      const nested = this.nestedActorOn(base, segments, scope);
      const targetScope =
        nested === undefined
          ? ownScope
          : {
              ...this.enterActor(nested.actor, scope, base === scope.actor ? segments.slice(0, nested.depth) : []),
              source: ownScope.source,
              current: ownScope.current,
              path: segments.slice(nested.depth),
            };
      const value =
        found !== null && found.parent === targetScope.current
          ? this.evaluateField(found.parent, found.key, rawTarget, targetScope)
          : this.evaluate(rawTarget, targetScope);
      this.cache.set(key, value);
      return value;
    } finally {
      this.resolving.pop();
    }
  }

  /** Wrappers dereference to the value they hold, so a bare `@.xp` reads the
   * filled param and predicates see through a field's event history. */
  private derefValue(rawTarget: unknown): unknown {
    if (RecordNode.isParam(rawTarget)) {
      // Raw records hold the fill in `value`; evaluated ones (what `!validate`
      // rules read) print it as `:value`.
      const slot = rawTarget[VALUE_KEY] !== undefined ? rawTarget[VALUE_KEY] : rawTarget[PARAM_VALUE_KEY];
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
      if (isPrivateKey(seg)) this.assertVisible(entry.parent, entry.key, path, scope);
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
      assign: (ref: string, value: unknown, op: AssignOp) => {
        const { root, path } = parseRef(ref);
        const base = this.rootFor(root, scope);
        return this.write(base, root, path, value, op, scope);
      },
      assignEach: (ref: string, expr: string, op: AssignOp) => {
        const { root, path } = parseRef(ref);
        const base = this.rootFor(root, scope);
        for (const target of this.expandPaths(base, path, scope)) {
          const owner = getPath(base, target.slice(0, -1));
          if (owner === null || typeof owner !== 'object') continue;
          this.write(base, root, target, this.evalExpr(expr, { ...scope, current: owner }), op, scope);
        }
      },
    };
  }

  /** One assignment, filed like a patch write under the document whose
   * expression made it: `=` as `:set`, `+=` as `:add`, `-=` as `:subtract`. */
  private write(base: unknown, root: string, path: string[], value: unknown, op: AssignOp, scope: EvalRoots): unknown {
    // Dice roll once here, so the event and the field hold the same number.
    const amount = op === '=' ? value : Number(value);
    let next = amount;
    if (op !== '=') {
      const held = Number(
        this.resolveRef(root === CURRENT ? `.${path.join('.')}` : `${root}.${path.join('.')}`, scope),
      );
      next = op === '+' ? held + (amount as number) : held - (amount as number);
    }
    const slot = this.ownerOf(base, path);
    if (slot) {
      const kind = op === '=' ? SET_KEY : op === '+' ? ADD_KEY : SUBTRACT_KEY;
      this.recordEvent(
        slot.owner,
        slot.key,
        kind,
        deepClone(amount),
        scope.source,
        this.fieldSource(slot.owner, slot.key),
        scope.at,
      );
    }
    setPath(base, path, next);
    this.cache.clear();
    return next;
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
      const file = tmpl[1]!;
      const doc = this.docs.get(file);
      if (doc === undefined) throw new Error(`template not loaded: ${file}`);
      const clone = this.clone(doc);
      // The clone keeps the document's name so patch events can cite it.
      if (clone && typeof clone === 'object') {
        this.origins.set(clone, file);
        if (scope.doc !== null && typeof scope.doc === 'object') this.parents.set(clone, scope.doc);
      }
      return this.claim(clone, file);
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
      if (this.expandCalls(raw, scope)) this.cache.clear();
      if (RecordNode.materializeParams(raw, scope.provided)) this.cache.clear();
      return this.evaluate(raw, { ...scope, path: [] });
    }
    return parse(raw).evaluate(this, scope);
  }

  /**
   * Evaluate the field `record[key]` (raw value `raw`) under `scope`. An
   * expression field evaluates once per cache lifetime, however it is reached
   * (any ref spelling, or the sheet walk), so a roll reads the same everywhere.
   */
  evaluateField(record: object, key: string, raw: unknown, fieldScope: EvalRoots): unknown {
    // List items keep the source of the field holding the list; a call's
    // copy keeps the `#` it was written against.
    const homed = { ...fieldScope, home: this.homes.get(record) };
    const scope = Array.isArray(record) ? homed : { ...homed, source: this.fieldSource(record, key) };
    const memoizable =
      typeof raw === 'string' && ExpressionNode.matches(raw) && Object.keys(scope.params ?? {}).length === 0;
    if (!memoizable) return this.evaluate(raw, scope);
    const memo = `field|${this.idOf(scope.home ?? scope.doc)}|${this.idOf(scope.actor)}|${this.idOf(record)}|${key}`;
    if (this.cache.has(memo)) return this.cache.get(memo);
    const value = this.evaluate(raw, scope);
    this.cache.set(memo, value);
    return value;
  }

  /** The document that wrote `record[key]`: its latest write's `:source`,
   * else the document the record came from. */
  fieldSource(record: object, key: string): string | undefined {
    const log = this.fieldEvents.get(record)?.get(key);
    const last = log?.at(-1) as Record<string, unknown> | undefined;
    if (last !== undefined) return last[SOURCE_KEY] as string | undefined;
    return this.owners.get(record);
  }

  /** Whether the expression being evaluated may reach `record[key]`: always,
   * unless it is a `_` field another document wrote. */
  private visible(record: object, key: string, scope: EvalRoots): boolean {
    return !isPrivateKey(key) || (this.fieldSource(record, key) ?? '') === (scope.source ?? '');
  }

  /** Throw unless the expression being evaluated was written by the document
   * that wrote the `_` field it reaches. */
  private assertVisible(record: object, key: string, path: string[], scope: EvalRoots): void {
    if (this.visible(record, key, scope)) return;
    const owner = this.fieldSource(record, key) ?? '';
    const reader = scope.source ?? '';
    const at = path.join('.');
    throw new Error(
      `private field: ${at} belongs to ${owner || 'an unnamed document'}, not ${reader || 'an unnamed document'}`,
    );
  }

  /** Concrete paths for a raw `path`, each `*` swapped for every child it
   * matches; segments after it are not checked. */
  private expandPaths(base: unknown, path: string[], scope: EvalRoots): string[][] {
    const star = path.findIndex((segment) => parseWildcard(segment) !== null);
    if (star < 0) return [path];
    const { predicate } = parseWildcard(path[star] ?? '') ?? {};
    const prefix = path.slice(0, star);
    const container = prefix.length === 0 ? base : getPath(base, prefix);
    return this.childKeys(container, scope)
      .filter((key) => predicate === undefined || this.holdsFor(predicate, getChild(container, key), scope))
      .flatMap((key) => this.expandPaths(base, [...prefix, key, ...path.slice(star + 1)], scope));
  }

  /** A `{predicate}` test, with `.` bound to the child. A child missing what
   * the predicate reads simply does not match. */
  private holdsFor(predicate: string, child: unknown, scope: EvalRoots): boolean {
    try {
      return Boolean(this.evalExpr(predicate, { ...scope, current: child }));
    } catch (err) {
      if ((err as Error).message.startsWith('unresolvable reference')) return false;
      throw err;
    }
  }

  /** The data children a `*` matches: list items, or record fields — never
   * metadata, rules, functions, patch keys or another document's `_` fields. */
  private childKeys(container: unknown, scope: EvalRoots): string[] {
    if (Array.isArray(container)) return container.map((_item, index) => String(index));
    if (container === null || typeof container !== 'object' || RecordNode.isParam(container)) return [];
    return Object.keys(container).filter(
      (key) =>
        !isMetaKey(key) &&
        !isValidateKey(key) &&
        !isBareSigil(key) &&
        !isPathKey(key) &&
        !FunctionNode.isKey(key) &&
        key !== ACTOR_KEY &&
        key !== IF_KEY &&
        key !== THEN_KEY &&
        !key.startsWith('+') &&
        this.visible(container, key, scope),
    );
  }

  /** Mark every record and list in `tree` not yet owned as written by `source`. */
  private claim<T>(tree: T, source: string | undefined): T {
    if (source === undefined) return tree;
    const visit = (node: unknown) => {
      if (node === null || typeof node !== 'object' || node instanceof Die) return;
      if (!this.owners.has(node)) this.owners.set(node, source);
      for (const child of Object.values(node)) visit(child);
    };
    visit(tree);
    return tree;
  }

  /** Evaluate a whole loaded document as an actor (`#` and `@` coincide). */
  evaluateDoc(file: string, provided?: Record<string, unknown>): unknown {
    const raw = this.docs.get(file);
    if (raw === undefined) throw new Error(`document not loaded: ${file}`);
    this.claim(raw, file);
    const scope: EvalRoots = { doc: raw, actor: raw, app: this.appRoot, current: raw, provided };
    // Calls (and mixins) expand before params fill, so their params fill too.
    if (this.expandCalls(raw, scope)) this.cache.clear();
    if (RecordNode.materializeParams(raw, provided)) this.cache.clear();
    return this.evaluate(raw, { ...scope, path: [] });
  }

  /**
   * Report every `:param` node in a loaded document as `[{ path, doc? }]`
   * — paths needing user-provided values plus each node's attached `:doc`.
   */
  missingParams(file: string): MissingParam[] {
    const loaded = this.docs.get(file);
    if (loaded === undefined) throw new Error(`document not loaded: ${file}`);
    // A query must not change the document: expanding calls on it in place
    // would also consume its mixins before anything resolves.
    const raw = this.clone(loaded);
    if (loaded !== null && typeof loaded === 'object')
      this.origins.set(raw as object, this.origins.get(loaded) ?? file);
    this.expandCalls(raw, { doc: raw, actor: raw, app: this.appRoot, current: raw });
    return RecordNode.collectParams(raw);
  }

  /**
   * Write override values into the raw tree (`.`/`#`/`@` target the actor,
   * `$` targets the app; bare paths default to the actor). Overridden paths
   * are replaced wholesale — derivations never run and missing paths are
   * created — but a `:param` record keeps its `:type` contract. Mutates like
   * `apply`; re-load or re-resolve for a pristine tree.
   *
   * Changed values file an `override` event. Overrides apply both before and
   * after the patches, so re-writing the value already there is not an event.
   */
  applyOverrides(actorRaw: unknown, overrides: Record<string, unknown>): void {
    this.asSource(OVERRIDE_SOURCE, actorRaw, () => {
      for (const [key, value] of Object.entries(overrides)) {
        const normalized = /^[.@#$]/.test(key) ? key : `@.${key}`;
        const { root, path } = parseRef(normalized);
        if (path.length === 0) continue;
        const base = root === APP ? this.appRoot : actorRaw;
        if (base === null || typeof base !== 'object') continue;
        // A path through a value not yet expanded (a `$tmpl` call) waits
        // until expansion enters it.
        if (crossesScalar(base, path)) continue;
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
    const scope: EvalRoots = {
      doc: actorRaw,
      actor: actorRaw,
      app: this.appRoot,
      current: actorRaw,
      provided,
      overrides,
    };
    this.expandCalls(actorRaw, scope);
    this.applyOverrides(actorRaw, overrides);
    this.shareWithApp(actorRaw);
    const outstanding = RecordNode.collectParams(actorRaw).filter((param) => provided[param.path] === undefined);
    if (outstanding.length > 0) return { query: outstanding };
    return { data: debug(this.evaluate(actorRaw, scope)) };
  }

  /** Point `$` at the resolved entry's own (expanded) top-level values in place
   * of the copies taken on load, so `$.x` and `#.x` read the same tree. */
  private shareWithApp(entry: unknown): void {
    const source = this.sourceOf(entry);
    if (source === undefined || entry === null || typeof entry !== 'object' || Array.isArray(entry)) return;
    for (const [key, value] of Object.entries(entry)) {
      const held = this.appRoot[key];
      if (held !== null && typeof held === 'object' && this.owners.get(held) === source) this.appRoot[key] = value;
    }
  }

  // -- patches (class files, levels, conditions) ----------------------------

  /**
   * Apply an applied-document (e.g. a class file) onto an actor's raw tree.
   * Leveling lives in the files: gate per-level content with `$if` on actor
   * state (e.g. `@.level >= 5`). Evaluate with provided values first so
   * conditions read materialized params.
   */
  apply(actorRaw: unknown, patchFile: string, provided?: Record<string, unknown>): unknown {
    const patch = this.docs.get(patchFile);
    if (patch === undefined) throw new Error(`patch document not loaded: ${patchFile}`);
    return this.applyRaw(actorRaw, patch, patchFile, provided);
  }

  /** Apply an in-memory patch (e.g. a `$tmpl('…')` clone) onto an actor.
   * `source` names it in the event logs; defaults to the document it came from. */
  applyRaw(actorRaw: unknown, patch: unknown, source?: string, provided?: Record<string, unknown>): unknown {
    const scope: EvalRoots = {
      doc: patch,
      actor: actorRaw,
      app: this.appRoot,
      current: actorRaw,
      provided,
    };
    if (patch !== null && typeof patch === 'object') this.actorOf.set(patch, actorRaw);
    const patchSource = source ?? this.sourceOf(patch);
    this.claim(actorRaw, this.sourceOf(actorRaw) ?? '');
    this.asSource(patchSource, actorRaw, () => this.applyNode(actorRaw, patch, { ...scope, source: patchSource }));
    // Whatever is still unowned was created by the patch.
    this.claim(actorRaw, patchSource ?? '');
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

  /** One `{ :source?, :line?, :column?, :set | :add | :subtract }` entry. */
  private event(
    source: string | undefined,
    kind: string,
    value: unknown,
    at: Location | undefined,
  ): Record<string, unknown> {
    return {
      ...(source === undefined ? {} : { [SOURCE_KEY]: source }),
      ...(at === undefined ? {} : { [LINE_KEY]: at.line, [COLUMN_KEY]: at.column }),
      [kind]: value,
    };
  }

  /** Where `record[key]` was written in its source document, when known. */
  locationOf(record: object, key: string): Location | undefined {
    return this.locations.get(record)?.get(key);
  }

  /** A structural copy that keeps the source locations of its keys. */
  private clone<T>(value: T): T {
    const copy = deepClone(value);
    copyLocations(value, copy, this.locations);
    this.copyHomes(value, copy);
    return copy;
  }

  private copyHomes(from: unknown, to: unknown): void {
    if (from === null || typeof from !== 'object' || to === null || typeof to !== 'object') return;
    const home = this.homes.get(from);
    if (home !== undefined && !this.homes.has(to)) this.homes.set(to, home);
    for (const [key, child] of Object.entries(from)) this.copyHomes(child, (to as Record<string, unknown>)[key]);
  }

  /** Run `write` with events citing `record[key]`'s location — or the
   * enclosing one, for keys with none (e.g. a call's copied body). */
  private writing(record: object, key: string, write: () => void): void {
    const at = this.locationOf(record, key);
    if (at === undefined) {
      write();
      return;
    }
    const outer = this.writingAt;
    this.writingAt = at;
    try {
      write();
    } finally {
      this.writingAt = outer;
    }
  }

  /** Note a patch write, in application order. Call before writing. */
  private recordEvent(
    target: Record<string, unknown>,
    key: string,
    kind: string,
    value: unknown,
    source = this.applySource,
    origin = this.actorSource,
    at = this.writingAt,
  ): void {
    this.seedEvents(target, key, origin).push(this.event(source, kind, value, at));
  }

  /** Open a field's log, recording what it already holds as the first event.
   * Call before mutating in place, so that origin is the prior value. */
  private seedEvents(target: Record<string, unknown>, key: string, origin = this.actorSource): unknown[] {
    let fields = this.fieldEvents.get(target);
    if (fields === undefined) {
      fields = new Map();
      this.fieldEvents.set(target, fields);
    }
    let log = fields.get(key);
    if (log === undefined) {
      log = key in target ? [this.event(origin, SET_KEY, deepClone(target[key]), this.locationOf(target, key))] : [];
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
   * `record[key]`'s events with each written expression resolved where it
   * landed. The latest `:set` is the field's own `value`, so the two agree
   * even when it rolled.
   */
  resolvedEventsFor(record: object, key: string, value: unknown, scope: EvalRoots): unknown[] | undefined {
    const log = this.eventsFor(record, key);
    if (log === undefined) return undefined;
    return log.map((entry, i) => {
      const event = entry as Record<string, unknown>;
      const kind = [SET_KEY, ADD_KEY, SUBTRACT_KEY].find((k) => k in event) ?? SET_KEY;
      if (i === log.length - 1 && kind === SET_KEY) return { ...event, [kind]: value };
      return { ...event, [kind]: this.resolveWritten(event, kind, event[kind], scope) };
    });
  }

  /** A logged write's value: expressions evaluate (once, keyed on the event), lists item by item. */
  private resolveWritten(owner: object, key: string, raw: unknown, scope: EvalRoots): unknown {
    if (Array.isArray(raw)) return raw.map((item, i) => this.resolveWritten(owner, `${key}.${i}`, item, scope));
    if (typeof raw === 'string' && ExpressionNode.matches(raw)) return this.evaluateField(owner, key, raw, scope);
    return raw;
  }

  /** The record owning the path's last segment and the key within it,
   * creating parents the way `setPath` does so events can be filed first. */
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

  /** A patch value that is one call to a definition (`$tmpl('…')`,
   * `$.feature.x()`) inlines here, so `:param` nodes inside it land in the
   * actor tree instead of staying an expression. Calls that yield anything
   * but a record stay as written, and so stay lazy. */
  private inlinePatchValue(value: unknown, scope: EvalRoots): unknown {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!CALL_EXPR.test(trimmed)) return value;
    try {
      const inlined = this.evalExpr(trimmed, scope);
      return FunctionNode.isRecordBody(inlined) ? inlined : value;
    } catch {
      return value; // not resolvable yet — leave the expression in place
    }
  }

  /**
   * Merge `$mixin('file')` into the actor of the nearest document up the
   * template chain — the calling document first — declaring the actor the
   * mixin's `@` names (`$actor: X`, or `@: X` on an applied document). Choices fill in first, so the mixin can gate on one an earlier
   * patch just declared.
   */
  private mixin(call: string, scope: EvalRoots): void {
    const file = call.trim().match(MIXIN_CALL)?.[1] ?? '';
    const doc = this.docs.get(file);
    if (doc === null || typeof doc !== 'object') throw new Error(`mixin not loaded: ${file}`);
    const type = (doc as Record<string, unknown>)[ACTOR];
    if (typeof type !== 'string')
      throw new Error(`mixin ${file} must name the actor it attaches to with a top-level \`@\``);
    const actor = this.mixinTarget(type, scope);
    if (actor === undefined) throw new Error(`$mixin('${file}'): no parent document defines actor ${type}`);
    // Cite the document by its loaded path, so its events open the right file.
    const source = this.origins.get(doc) ?? file;
    const patch = this.claim(this.clone(doc as object), source);
    this.origins.set(patch, source);
    if (scope.doc !== null && typeof scope.doc === 'object') this.parents.set(patch, scope.doc);
    RecordNode.materializeParams(actor, scope.provided);
    this.applyRaw(actor, patch, source, scope.provided);
  }

  /** The actor built (`$actor: type`) or patched (`@: type`) by the nearest such document. */
  private mixinTarget(type: string, scope: EvalRoots): unknown {
    const seen = new Set<unknown>();
    for (let doc = scope.doc; doc !== null && typeof doc === 'object' && !seen.has(doc); doc = this.parents.get(doc)) {
      seen.add(doc);
      const record = doc as Record<string, unknown>;
      if ((record[ACTOR_KEY] ?? record[ACTOR]) !== type) continue;
      const actor = this.actorOf.get(doc) ?? (doc === scope.actor ? doc : undefined);
      if (actor !== undefined) return actor;
    }
    return undefined;
  }

  /** Expand calls written as plain document values, so the nodes they hand
   * back — `:param` records included — are in the tree before anything looks
   * for them. Anything that is not a record call is left as written. */
  expandCalls(raw: unknown, scope: EvalRoots): boolean {
    let wrote = false;
    const visit = (node: unknown, outer: EvalRoots, path: string[]) => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => {
          const next = this.inlinePatchValue(item, outer);
          if (next !== item) {
            node[index] = this.claim(next, this.owners.get(node) ?? '');
            wrote = true;
          }
          visit(node[index], outer, [...path, String(index)]);
        });
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      // A nested actor document is its own `#` and `@`: its mixins land on it.
      const nested = this.isNestedActor(record, outer);
      const inner = nested ? this.enterActor(record, outer, path) : outer;
      if (nested && inner.overrides) this.applyOverrides(record, inner.overrides);
      const base = nested ? [] : path;
      for (const [key, value] of Object.entries(record)) {
        if (isMetaKey(key) || isValidateKey(key)) continue;
        if (typeof value === 'string' && MIXIN_CALL.test(value.trim())) {
          delete record[key]; // consumed: the mixin merges into the actor instead
          this.mixin(value, inner);
          wrote = true;
          continue;
        }
        const next = this.inlinePatchValue(value, inner);
        if (next !== value) {
          record[key] = this.claim(next, this.fieldSource(record, key) ?? '');
          wrote = true;
        }
        const child = record[key];
        const mixins = child !== null && typeof child === 'object' && !Array.isArray(child) && hasMixin(child);
        visit(child, inner, [...base, key]);
        // A record that only held mixin calls leaves nothing behind.
        if (mixins && Object.keys(child as object).length === 0) delete record[key];
      }
    };
    visit(raw, scope, []);
    return wrote;
  }

  /** The innermost nested actor `path` passes through from `base`, and how
   * many segments in it starts. */
  private nestedActorOn(
    base: unknown,
    path: string[],
    scope: EvalRoots,
  ): { actor: Record<string, unknown>; depth: number } | undefined {
    let found: { actor: Record<string, unknown>; depth: number } | undefined;
    let node = base;
    for (const [index, seg] of path.slice(0, -1).entries()) {
      node = getChild(node, seg);
      if (node === null || typeof node !== 'object' || Array.isArray(node)) break;
      const record = node as Record<string, unknown>;
      if (this.isNestedActor(record, scope)) found = { actor: record, depth: index + 1 };
    }
    return found;
  }

  /** Whether `record` declares an actor (`$actor: X`) other than the one in scope. */
  isNestedActor(record: Record<string, unknown>, scope: EvalRoots): boolean {
    return typeof record[ACTOR_KEY] === 'string' && record !== scope.actor;
  }

  /** The scope inside a nested actor at `path` (relative to the outer actor):
   * `#` and `@` become it, and provided values are read relative to it. */
  enterActor(record: Record<string, unknown>, scope: EvalRoots, path: string[]): EvalRoots {
    return {
      ...scope,
      doc: record,
      actor: record,
      current: record,
      home: undefined,
      provided: RecordNode.nestProvided(scope.provided, path),
      overrides: scope.overrides && RecordNode.nestProvided(scope.overrides, path),
      path: scope.path === undefined ? undefined : [],
    };
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
    // A root `$if` gates the whole document, like any other patch node.
    const rec = patch as Record<string, unknown>;
    if (!this.condPasses(rec, scope)) return;
    if (THEN_KEY in rec) this.applyPatchObject(rec[THEN_KEY], scope);
    const target = actorRaw as Record<string, unknown>;
    for (const [key, value] of Object.entries(rec)) {
      if (isBareSigil(key) || key === ACTOR_KEY) continue;
      if (isMetaKey(key) || isValidateKey(key)) {
        target[key] = deepClone(value);
        continue;
      }
      if (key === IF_KEY || key === THEN_KEY) continue; // handled by mergeInto
      this.writing(patch, key, () => this.mergeEntry(target, key, value, scope));
    }
  }

  private applyAtPath(pathKey: string, rawValue: unknown, scope: EvalRoots): void {
    const value = this.inlinePatchValue(rawValue, scope);
    // A path key written `+@.attacks` adds to what is there.
    const adds = pathKey.startsWith('+');
    const { root, path } = parseRef(stripPlus(pathKey));
    const base = this.rootFor(root, scope);
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
      this.applyArrayWrite(target as unknown[], value, slot, pathKey);
      return;
    }
    const slot = this.ownerOf(base, path);
    if (adds) {
      const sum = addRaw(slot ? slot.owner[slot.key] : undefined, value, pathKey);
      if (slot) this.recordEvent(slot.owner, slot.key, ADD_KEY, deepClone(value));
      setPath(base, path, sum);
      return;
    }
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
        this.writing(rec, k, () => this.mergeEntry(tgt, k, v, scope));
      }
      return;
    }
    for (const [k, v] of Object.entries(rec)) {
      this.writing(rec, k, () => this.mergeEntry(tgt, k, v, scope));
    }
  }

  /** A `$then` block is itself a patch: path keys are absolute. */
  private applyPatchObject(patch: unknown, scope: EvalRoots): void {
    if (Array.isArray(patch)) return;
    if (!patch || typeof patch !== 'object') return;
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (isBareSigil(k) || k === ACTOR_KEY || k === IF_KEY || k === THEN_KEY) continue;
      if (isMetaKey(k) || isValidateKey(k)) continue;
      const record = patch as Record<string, unknown>;
      if (isPathKey(k)) {
        this.writing(record, k, () => this.applyAtPath(k, v, scope));
        continue;
      }
      this.writing(record, k, () => this.mergeEntry(scope.actor as Record<string, unknown>, k, v, scope));
    }
  }

  private mergeEntry(target: Record<string, unknown>, key: string, rawValue: unknown, scope: EvalRoots): void {
    if (typeof rawValue === 'string' && MIXIN_CALL.test(rawValue.trim())) {
      this.mixin(rawValue, scope); // the key holding the call is consumed
      return;
    }
    const value = this.inlinePatchValue(rawValue, scope);
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
      // A record of pure metadata writes no field events, so the addition
      // itself is the only trace. Scalars and lists log their own content.
      if (key !== k) this.recordEvent(target, k, ADD_KEY, k);
      // Always merge through mergeInto so nested `+`, path keys and
      // `$if`/`$then` wrappers are consumed rather than stored raw.
      const created = typeof target[k] !== 'object' || target[k] === null || Array.isArray(target[k]);
      if (created) target[k] = {};
      this.mergeInto(target[k], value, { ...scope, current: target[k] });
      // A record that only held mixin calls leaves nothing behind.
      if (created && Object.keys(target[k] as object).length === 0 && hasMixin(value)) delete target[k];
      return;
    }
    if (Array.isArray(value)) {
      this.seedEvents(target, k); // before the append, not after
      if (!Array.isArray(target[k])) target[k] = [];
      this.applyArrayWrite(target[k] as unknown[], value, { owner: target, key: k }, key);
      return;
    }
    this.recordEvent(target, k, SET_KEY, deepClone(value));
    target[k] = deepClone(value);
  }

  /** Apply an array patch and file it: `+item` entries as `:add`, a plain
   * list as `:set` — the document stating what the list is. */
  private applyArrayWrite(
    target: unknown[],
    items: unknown[],
    slot: { owner: Record<string, unknown>; key: string } | null,
    label = slot?.key,
  ): void {
    const additive = isAdditiveList(items, label);
    const added = this.applyArray(target, items, label);
    if (slot === null) return;
    if (!additive) this.recordEvent(slot.owner, slot.key, SET_KEY, deepClone(items));
    else if (added.length > 0) this.recordEvent(slot.owner, slot.key, ADD_KEY, added);
  }

  /** A plain list replaces the target; `+item` entries append deduplicated
   * (plain items alongside them append raw). Returns what was written. */
  private applyArray(target: unknown[], items: unknown[], label?: string): unknown[] {
    if (!isAdditiveList(items, label)) {
      const replacement = items.map(deepClone);
      target.length = 0;
      target.push(...replacement);
      return replacement;
    }
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

/** Whether walking `path` from `base` passes through a scalar before its last segment. */
function crossesScalar(base: unknown, path: string[]): boolean {
  let node = base;
  for (const seg of path.slice(0, -1)) {
    node = (node as Record<string, unknown>)[seg];
    if (node === undefined || node === null) return false;
    if (typeof node !== 'object') return true;
  }
  return false;
}

/** Whether a patch value holds a `$mixin('…')` call anywhere inside. */
function hasMixin(value: unknown): boolean {
  if (typeof value === 'string') return MIXIN_CALL.test(value.trim());
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value).some(hasMixin);
}
