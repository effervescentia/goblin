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
  CURRENT,
  DIE_LITERAL,
  DOCUMENT,
  IF_KEY,
  MIXIN_CALL,
  OVERRIDE_SOURCE,
  PARAM_KEY,
  PARAM_VALUE_KEY,
  SET_KEY,
  SOURCE_KEY,
  SUBTRACT_KEY,
  TEMPLATE_CALL,
  THEN_KEY,
  TYPE_KEY,
  VALIDATE_KEY,
  VALUE_KEY,
} from './constants';
import { Documents } from './documents';
import { type InputEvent, isInputEvent, latest, nest, type StateEvent } from './inputs';
import { type EngineEvent, Journal } from './journal';
import type { Location } from './locations';
import { Die, DieNode } from './nodes/die';
import { ExpressionNode } from './nodes/expression';
import { FunctionNode } from './nodes/function';
import { parse } from './nodes/parse';
import { type MissingParam, RecordNode } from './nodes/record';
import { debug } from './nodes/serialize';
import { Provenance } from './provenance';
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
  private readonly provenance = new Provenance();
  private readonly journal = new Journal(this.provenance);
  private readonly documents: Documents;
  /** Raw (unevaluated) documents by file name. */
  readonly docs: Map<string, unknown>;
  /** `$` — shared global namespace (cross-doc values). */
  readonly appRoot: Record<string, unknown>;
  /** `$lib` — standard library: natives bound in code, yaml helpers merged on load. */
  readonly library: Record<string, unknown>;
  /** Resolved-value cache + cycle guard for lazy references. */
  private readonly cache = new Map<string, unknown>();
  private readonly resolving: string[] = [];
  private readonly objIds = new WeakMap<object, number>();
  private nextId = 1;

  constructor(rootDir = '.') {
    this.documents = new Documents(this.provenance, rootDir);
    ({ docs: this.docs, appRoot: this.appRoot, library: this.library } = this.documents);
  }

  loadFile(file: string): Promise<unknown> {
    return this.documents.loadFile(file);
  }

  /** Merge a parsed library document under the native defaults. */
  mergeLib(data: unknown): void {
    this.documents.mergeLib(data);
  }

  /** Store a document under `file`, merging top-level tables into `$`. */
  register(file: string, data: unknown, text?: string): unknown {
    return this.documents.register(file, data, text);
  }

  /** `$tmpl('other.yaml')` helper + any registered template loader. */
  loadTemplate(file: string): Promise<unknown> {
    return this.documents.loadTemplate(file);
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
    const home = this.provenance.homes.get(parent);
    if (home !== undefined) return home;
    const doc = scope.home ?? scope.doc;
    const callerDoc = doc !== null && typeof doc === 'object' ? this.provenance.owners.get(doc) : undefined;
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
    return this.provenance.settle(tree, doc);
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
      // A target inside a nested actor reads `#` and `@` as that actor.
      const nested = this.nestedActorOn(base, segments, scope);
      if (found !== null) {
        const fnScope =
          nested === undefined
            ? scope
            : this.enterActor(nested.actor, scope, base === scope.actor ? segments.slice(0, nested.depth) : []);
        const fn = this.entryCallable(found, fnScope);
        if (fn !== undefined) return fn;
      }
      const rawTarget = this.derefValue(found?.value);
      // Every sigil names exactly one tree: a missing path never falls back.
      if (rawTarget === undefined) return undefined;
      const ownScope = {
        ...scope,
        source: found === null ? scope.source : this.fieldSource(found.parent, found.key),
        // The target reads `#` as its own document, not the reader's.
        home: found === null ? undefined : this.provenance.homes.get(found.parent),
        current: parentOf(base, segments) ?? scope.current,
        // The target's own path, so `:param` nodes inside it look up provided
        // values by where they live, not where the reference was written.
        path: root === CURRENT ? [...(scope.path ?? []), ...segments] : segments,
      };
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
    // Each statement's value is computed just before its assign: rolls since
    // the last one are that value's.
    let mark = this.journal.mark();
    return {
      resolve: (ref: string) => {
        const value = this.resolveRef(ref, scope);
        if (value === undefined) throw new Error(`unresolvable reference: ${ref}`);
        return value;
      },
      assign: (ref: string, value: unknown, op: AssignOp) => {
        const { root, path } = parseRef(ref);
        const base = this.rootFor(root, scope);
        const next = this.write(base, root, path, value, op, scope, this.journal.rolledSince(mark));
        mark = this.journal.mark();
        return next;
      },
      assignEach: (ref: string, expr: string, op: AssignOp) => {
        const { root, path } = parseRef(ref);
        const base = this.rootFor(root, scope);
        for (const target of this.expandPaths(base, path, scope)) {
          const owner = getPath(base, target.slice(0, -1));
          if (owner === null || typeof owner !== 'object') continue;
          const before = this.journal.mark();
          const value = this.evalExpr(expr, { ...scope, current: owner });
          this.write(base, root, target, value, op, scope, this.journal.rolledSince(before));
        }
        mark = this.journal.mark();
      },
    };
  }

  /** One assignment, filed like a patch write under the document whose
   * expression made it: `=` as `:set`, `+=` as `:add`, `-=` as `:subtract`. */
  private write(
    base: unknown,
    root: string,
    path: string[],
    value: unknown,
    op: AssignOp,
    scope: EvalRoots,
    rolled = false,
  ): unknown {
    // Dice roll once here, so the event and the field hold the same number.
    let amount = op === '=' ? value : Number(value);
    const slot = this.ownerOf(base, path);
    if (slot) {
      const kind = op === '=' ? SET_KEY : op === '+' ? ADD_KEY : SUBTRACT_KEY;
      amount = this.journal.record(slot.owner, slot.key, kind, deepClone(amount), {
        source: scope.source,
        origin: this.fieldSource(slot.owner, slot.key),
        at: scope.at,
        // Only the call's own assignments: lazy patch writes it triggers are not its doing.
        cause: this.journal.cause,
        rolled,
      });
    }
    let next = amount;
    if (op !== '=') {
      const held = Number(
        this.resolveRef(root === CURRENT ? `.${path.join('.')}` : `${root}.${path.join('.')}`, scope),
      );
      next = op === '+' ? held + Number(amount) : held - Number(amount);
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
      const [, file = '', namespace] = tmpl;
      const doc = this.docs.get(file);
      if (doc === undefined) throw new Error(`template not loaded: ${file}`);
      const clone = this.provenance.clone(doc);
      if (namespace !== undefined) this.provenance.nameActor(clone, file, namespace);
      // The clone keeps the document's name so patch events can cite it.
      if (clone && typeof clone === 'object') {
        this.provenance.origins.set(clone, file);
        if (scope.doc !== null && typeof scope.doc === 'object') this.provenance.parents.set(clone, scope.doc);
      }
      return this.provenance.claim(clone, file);
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
      if (RecordNode.materializeParams(raw, scope.inputs, this.namespaceOf)) this.cache.clear();
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
    const homed = { ...fieldScope, home: this.provenance.homes.get(record) };
    const scope = Array.isArray(record) ? homed : { ...homed, source: this.fieldSource(record, key) };
    const memoizable =
      typeof raw === 'string' && ExpressionNode.matches(raw) && Object.keys(scope.params ?? {}).length === 0;
    if (!memoizable) return this.evaluate(raw, scope);
    const memo = `field|${this.idOf(scope.home ?? scope.doc)}|${this.idOf(scope.actor)}|${this.idOf(record)}|${key}`;
    if (this.cache.has(memo)) return this.cache.get(memo);
    const value = this.journal.evaluating(record, key, () => this.evaluate(raw, scope));
    this.cache.set(memo, value);
    return value;
  }

  /** The document that wrote `record[key]`: its latest write's `:source`,
   * else the document the record came from. */
  fieldSource(record: object, key: string): string | undefined {
    const last = this.journal.lastWrite(record, key);
    if (last !== undefined) return last[SOURCE_KEY] as string | undefined;
    return this.provenance.owners.get(record);
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

  /** Evaluate a whole loaded document as an actor (`#` and `@` coincide).
   * Only parameter events apply; `resolve` replays overrides too. */
  evaluateDoc(file: string, inputs: InputEvent[] = []): unknown {
    const raw = this.docs.get(file);
    if (raw === undefined) throw new Error(`document not loaded: ${file}`);
    this.provenance.claim(raw, file);
    const keyed = this.splitNamespaced(
      raw,
      inputs.filter((event) => event.type === 'parameter'),
    );
    const scope: EvalRoots = { doc: raw, actor: raw, app: this.appRoot, current: raw, ...keyed };
    // Calls (and mixins) expand before params fill, so their params fill too.
    if (this.expandCalls(raw, scope)) this.cache.clear();
    if (RecordNode.materializeParams(raw, keyed.inputs, this.namespaceOf)) this.cache.clear();
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
    const raw = this.provenance.clone(loaded);
    if (loaded !== null && typeof loaded === 'object')
      this.provenance.origins.set(raw as object, this.provenance.origins.get(loaded) ?? file);
    this.expandCalls(raw, { doc: raw, actor: raw, app: this.appRoot, current: raw });
    return RecordNode.collectParams(raw, this.namespaceOf);
  }

  /**
   * Write the latest `set` event per path into the raw tree (`.`/`#`/`@` target the actor,
   * `$` targets the app; bare paths default to the actor). Overridden paths
   * are replaced wholesale — derivations never run and missing paths are
   * created — but a `:param` record keeps its `:type` contract. Mutates like
   * `apply`; re-load or re-resolve for a pristine tree.
   *
   * Changed values file an `override` event citing the input's `version`.
   * Overrides apply both before and after the patches, so re-writing the
   * value already there is not an event.
   */
  applyOverrides(actorRaw: unknown, inputs: readonly InputEvent[]): void {
    this.journal.asSource(OVERRIDE_SOURCE, actorRaw, () => {
      for (const { path: key, value, version } of latest(inputs, 'override')) {
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
        if (slot && !sameValue(existing, value)) this.journal.override(slot.owner, slot.key, deepClone(value), version);
        setPath(base as Record<string, unknown>, path, deepClone(value));
      }
    });
  }

  /**
   * Resolve a document against an input event stream: `parameter` events fill
   * `:param` nodes (keyed by dotted path or alias), `set` events override
   * values. Satisfied documents return `{ data }` with the serialized result;
   * otherwise `{ query }` holds only the outstanding params. Param values of
   * the wrong `:type` still throw.
   */
  resolve(file: string, events: StateEvent[] = []): { data: unknown; result?: unknown } | { query: MissingParam[] } {
    const raw = this.docs.get(file);
    if (raw === undefined) throw new Error(`document not loaded: ${file}`);
    return this.resolveRaw(raw, events);
  }

  /**
   * Resolve an in-memory actor tree (e.g. composed from `actor`/`adopt`
   * entry keys): `{ data }` when the parameter events satisfy all params, else
   * `{ query }` with only the outstanding ones. Set events apply first;
   * invoke events then call their functions on the resolved tree, in order,
   * and the last one's return value comes back as `result`.
   */
  resolveRaw(
    actorRaw: unknown,
    events: StateEvent[] = [],
  ): { data: unknown; result?: unknown } | { query: MissingParam[] } {
    const inputs = events.filter(isInputEvent);
    const run = this.journal.begin(actorRaw, events, inputs);
    return Die.within(run, () => this.resolveInputs(actorRaw, inputs));
  }

  private resolveInputs(
    actorRaw: unknown,
    inputs: InputEvent[],
  ): { data: unknown; result?: unknown } | { query: MissingParam[] } {
    const keyed = this.splitNamespaced(actorRaw, inputs);
    this.applyOverrides(actorRaw, keyed.inputs);
    const scope: EvalRoots = { doc: actorRaw, actor: actorRaw, app: this.appRoot, current: actorRaw, ...keyed };
    this.expandCalls(actorRaw, scope);
    this.applyOverrides(actorRaw, keyed.inputs);
    this.shareWithApp(actorRaw);
    const outstanding = RecordNode.collectParams(actorRaw, this.namespaceOf, inputs);
    if (outstanding.length > 0) return { query: outstanding };
    const invokes = keyed.inputs.filter((event) => event.type === 'invoke');
    if (invokes.length === 0) return { data: debug(this.evaluate(actorRaw, scope)) };
    // The expansion `evaluate` would run: it re-applies nested actors'
    // overrides over the mixins that wrote under them.
    this.expandCalls(actorRaw, scope);
    RecordNode.materializeParams(actorRaw, keyed.inputs, this.namespaceOf);
    this.cache.clear();
    let result: unknown;
    for (const event of invokes) {
      result = this.invoke(event, { ...scope, path: [] });
      // A set given after the invoke still wins over what the call wrote,
      // nested actors included; earlier sets must not undo the call.
      const after = (events: InputEvent[]) => events.filter((e) => inputs.indexOf(e) > inputs.indexOf(event));
      const later = { inputs: after(keyed.inputs), namespaced: after(keyed.namespaced) };
      this.applyOverrides(actorRaw, later.inputs);
      this.expandCalls(actorRaw, { ...scope, ...later });
      this.cache.clear();
    }
    // Already expanded: a fresh expansion would re-apply every set.
    return { data: debug(this.evaluate(actorRaw, { ...scope, path: [] })), result: debug(result) ?? null };
  }

  /** Call the function an invoke event names (actor-relative unless led by a
   * sigil, like a set) with the event's arguments. */
  private invoke(event: InputEvent, scope: EvalRoots): unknown {
    const ref = /^[.@#$]/.test(event.path) ? event.path : `@.${event.path}`;
    const fn = this.resolveRef(ref, scope);
    if (typeof fn !== 'function') throw new Error(`invoke: ${event.path} is not a function`);
    const result = this.journal.invoke(event, () => fn(...(Array.isArray(event.value) ? event.value : [])));
    // A record-bodied function hands back a raw copy; evaluate it like any node.
    return result !== null && typeof result === 'object'
      ? this.evaluate(result, { ...scope, current: result })
      : result;
  }

  /** Split events whose path is led by an actor namespace (`aria.name`) from
   * path-addressed ones. Namespaces are found by scanning loaded documents, so
   * the split happens before expansion creates the actors that hold them. */
  private splitNamespaced(root: unknown, events: InputEvent[]): { inputs: InputEvent[]; namespaced: InputEvent[] } {
    const declared = new Set<string>();
    const scan = (node: unknown): void => {
      if (typeof node === 'string') {
        const namespace = node.trim().match(TEMPLATE_CALL)?.[2];
        if (namespace !== undefined) declared.add(namespace);
      } else if (node !== null && typeof node === 'object') Object.values(node).forEach(scan);
    };
    this.docs.forEach(scan);
    if (root !== null && typeof root === 'object' && !Array.isArray(root)) {
      for (const namespace of declared) {
        if (namespace in root) throw new Error(`actor namespace ${namespace} shadows a top-level key of the entry`);
      }
    }
    const isNamed = (event: InputEvent) => declared.has(event.path.split('.')[0] ?? '');
    // Parameter events stay whole: the root's param pre-fill reads both keys.
    // Override events split, since an unmatched path key would create `aria` at the root.
    // Invokes run from the root, so they stay whole too.
    return {
      inputs: events.filter((event) => event.type !== 'override' || !isNamed(event)),
      namespaced: events.filter((event) => event.type !== 'invoke' && isNamed(event)),
    };
  }

  /** The namespace a nested actor was given with `$tmpl('…', 'name')`. */
  readonly namespaceOf = (record: object): string | undefined => this.provenance.namespaceOf(record);

  /** Point `$` at the resolved entry's own (expanded) top-level values in place
   * of the copies taken on load, so `$.x` and `#.x` read the same tree. */
  private shareWithApp(entry: unknown): void {
    const source = this.provenance.sourceOf(entry);
    if (source === undefined || entry === null || typeof entry !== 'object' || Array.isArray(entry)) return;
    for (const [key, value] of Object.entries(entry)) {
      const held = this.appRoot[key];
      if (held !== null && typeof held === 'object' && this.provenance.owners.get(held) === source)
        this.appRoot[key] = value;
    }
  }

  // -- patches (class files, levels, conditions) ----------------------------

  /**
   * Apply an applied-document (e.g. a class file) onto an actor's raw tree.
   * Leveling lives in the files: gate per-level content with `$if` on actor
   * state (e.g. `@.level >= 5`). Evaluate with parameter events first so
   * conditions read materialized params.
   */
  apply(actorRaw: unknown, patchFile: string, inputs?: InputEvent[]): unknown {
    const patch = this.docs.get(patchFile);
    if (patch === undefined) throw new Error(`patch document not loaded: ${patchFile}`);
    return this.applyRaw(actorRaw, patch, patchFile, inputs);
  }

  /** Apply an in-memory patch (e.g. a `$tmpl('…')` clone) onto an actor.
   * `source` names it in the event logs; defaults to the document it came from. */
  applyRaw(actorRaw: unknown, patch: unknown, source?: string, inputs?: InputEvent[]): unknown {
    const scope: EvalRoots = {
      doc: patch,
      actor: actorRaw,
      app: this.appRoot,
      current: actorRaw,
      inputs: inputs?.filter((event) => event.type === 'parameter'),
    };
    if (patch !== null && typeof patch === 'object') this.provenance.actorOf.set(patch, actorRaw);
    const patchSource = source ?? this.provenance.sourceOf(patch);
    this.provenance.claim(actorRaw, this.provenance.sourceOf(actorRaw) ?? '');
    this.journal.asSource(patchSource, actorRaw, () =>
      this.applyNode(actorRaw, patch, { ...scope, source: patchSource }),
    );
    // Whatever is still unowned was created by the patch.
    this.provenance.claim(actorRaw, patchSource ?? '');
    return actorRaw;
  }

  // -- change events --------------------------------------------------------

  /** Where `record[key]` was written in its source document, when known. */
  locationOf(record: object, key: string): Location | undefined {
    return this.provenance.locationOf(record, key);
  }

  /** The logged writes that landed in `root` and every die rolled, as stream events. */
  events(root: unknown, data: unknown): EngineEvent[] {
    return this.journal.events(root, data);
  }

  /** The writes that produced `record[key]`, or undefined when untouched. */
  eventsFor(record: object, key: string): unknown[] | undefined {
    return this.journal.eventsFor(record, key);
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
      // A probe: anything it rolls is thrown away with a non-record result,
      // so it rolls scratch dice rather than taking the field's.
      const inlined = Die.within({ roll: Die.fresh }, () => this.evalExpr(trimmed, scope));
      return FunctionNode.isRecordBody(inlined) ? inlined : value;
    } catch (error) {
      // A template is always resolvable, so its errors (a bad namespace) are real.
      if (TEMPLATE_CALL.test(trimmed)) throw error;
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
    const source = this.provenance.origins.get(doc) ?? file;
    const patch = this.provenance.claim(this.provenance.clone(doc as object), source);
    this.provenance.origins.set(patch, source);
    if (scope.doc !== null && typeof scope.doc === 'object') this.provenance.parents.set(patch, scope.doc);
    RecordNode.materializeParams(actor, scope.inputs, this.namespaceOf);
    this.applyRaw(actor, patch, source, scope.inputs);
  }

  /** The actor built (`$actor: type`) or patched (`@: type`) by the nearest such document. */
  private mixinTarget(type: string, scope: EvalRoots): unknown {
    const seen = new Set<unknown>();
    for (
      let doc = scope.doc;
      doc !== null && typeof doc === 'object' && !seen.has(doc);
      doc = this.provenance.parents.get(doc)
    ) {
      seen.add(doc);
      const record = doc as Record<string, unknown>;
      if ((record[ACTOR_KEY] ?? record[ACTOR]) !== type) continue;
      const actor = this.provenance.actorOf.get(doc) ?? (doc === scope.actor ? doc : undefined);
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
            node[index] = this.provenance.claim(next, this.provenance.owners.get(node) ?? '');
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
      if (nested && inner.inputs) this.applyOverrides(record, inner.inputs);
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
          record[key] = this.provenance.claim(next, this.fieldSource(record, key) ?? '');
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
    this.provenance.assertUniqueNamespaces(raw);
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
   * `#` and `@` become it, and input events are read relative to it. */
  enterActor(record: Record<string, unknown>, scope: EvalRoots, path: string[]): EvalRoots {
    // A namespaced actor also reads events keyed by its namespace; those come
    // last, so they win.
    const namespace = this.provenance.namespaces.get(record);
    const named = namespace === undefined ? [] : nest(scope.namespaced, [namespace]);
    return {
      ...scope,
      doc: record,
      actor: record,
      current: record,
      home: undefined,
      inputs: [...nest(scope.inputs, path), ...named],
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
      this.journal.writing(patch, key, () => this.mergeEntry(target, key, value, scope));
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
      if (slot) this.journal.seed(slot.owner, slot.key); // before the append, not after
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
      const added = slot ? this.journal.record(slot.owner, slot.key, ADD_KEY, deepClone(value)) : value;
      setPath(base, path, addRaw(slot ? slot.owner[slot.key] : undefined, added, pathKey));
      return;
    }
    const written = slot ? this.journal.record(slot.owner, slot.key, SET_KEY, deepClone(value)) : value;
    setPath(base, path, deepClone(written));
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
        this.journal.writing(rec, k, () => this.mergeEntry(tgt, k, v, scope));
      }
      return;
    }
    for (const [k, v] of Object.entries(rec)) {
      this.journal.writing(rec, k, () => this.mergeEntry(tgt, k, v, scope));
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
        this.journal.writing(record, k, () => this.applyAtPath(k, v, scope));
        continue;
      }
      this.journal.writing(record, k, () => this.mergeEntry(scope.actor as Record<string, unknown>, k, v, scope));
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
      if (key !== k) this.journal.record(target, k, ADD_KEY, k);
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
      this.journal.seed(target, k); // before the append, not after
      if (!Array.isArray(target[k])) target[k] = [];
      this.applyArrayWrite(target[k] as unknown[], value, { owner: target, key: k }, key);
      return;
    }
    target[k] = deepClone(this.journal.record(target, k, SET_KEY, deepClone(value)));
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
    if (!additive) this.journal.record(slot.owner, slot.key, SET_KEY, deepClone(items));
    else if (added.length > 0) this.journal.record(slot.owner, slot.key, ADD_KEY, added);
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
