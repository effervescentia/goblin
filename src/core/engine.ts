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
  ACTOR_KEY,
  ADD_KEY,
  APP,
  CURRENT,
  DIE_LITERAL,
  FORMULA_KEY,
  IF_KEY,
  LABEL_KEY,
  OPTIONS_KEY,
  OVERRIDE_SOURCE,
  PARAM_KEY,
  PARAM_VALUE_KEY,
  PARTS_KEY,
  SET_KEY,
  SOURCE_KEY,
  SUBTRACT_KEY,
  TEMPLATE_CALL,
  THEN_KEY,
  TYPE_KEY,
  VALIDATE_KEY,
  VALUE_KEY,
} from '@/constants';
import { type InputEvent, isInputEvent, isWriteEvent, latest, nest, type StateEvent } from '@/inputs';
import { Die, DieNode } from '@/nodes/die';
import { ExpressionNode } from '@/nodes/expression';
import { FunctionNode } from '@/nodes/function';
import { parse } from '@/nodes/parse';
import { type MissingParam, RecordNode } from '@/nodes/record';
import { debug } from '@/nodes/serialize';
import {
  type AssignOp,
  compileBody,
  deepClone,
  type EvalRoots,
  formulaOf,
  getChild,
  getChildEntry,
  getPath,
  isBareSigil,
  isMetaKey,
  isPathKey,
  isPrivateKey,
  isValidateKey,
  ownerOf,
  parentOf,
  parseRef,
  parseWildcard,
  type ResolveHooks,
  rootFor,
  sameValue,
  setPath,
} from '@/utils';
import { type EngineEvent, Journal } from './journal';
import type { Location } from './locations';
import { Patcher } from './patcher';
import { Provenance } from './provenance';
import { Registry } from './registry';

export class GoblinEngine {
  private readonly provenance = new Provenance();
  private readonly journal = new Journal(this.provenance);
  private readonly patcher = new Patcher(this, this.journal, this.provenance);
  private readonly registry: Registry;
  /** Raw (unevaluated) documents by file name. */
  readonly docs: Map<string, unknown>;
  /** `$` — shared global namespace (cross-doc values). */
  readonly appRoot: Record<string, unknown>;
  /** `$lib` — standard library: natives bound in code, yaml helpers merged on load. */
  readonly library: Record<string, unknown>;
  /** Resolved-value cache + cycle guard for lazy references. */
  private readonly cache = new Map<string, unknown>();
  private readonly resolving: string[] = [];
  /** The `[Label](…)` parts each expression field evaluated, from its latest evaluation. */
  private readonly parts = new WeakMap<object, Map<string, Record<string, unknown>[]>>();
  private readonly objIds = new WeakMap<object, number>();
  private nextId = 1;

  constructor(rootDir = '.') {
    this.registry = new Registry(this.provenance, rootDir);
    ({ docs: this.docs, appRoot: this.appRoot, library: this.library } = this.registry);
  }

  loadFile(file: string): Promise<unknown> {
    return this.registry.loadFile(file);
  }

  /** Merge a parsed library document under the native defaults. */
  mergeLib(data: unknown): void {
    this.registry.mergeLib(data);
  }

  /** Store a document under `file`, merging top-level tables into `$`. */
  register(file: string, data: unknown, text?: string): unknown {
    return this.registry.register(file, data, text);
  }

  /** `$tmpl('other.yaml')` helper + any registered template loader. */
  loadTemplate(file: string): Promise<unknown> {
    return this.registry.loadTemplate(file);
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

  /** Mark a record call's copy as written in `doc`, so its `#` stays there. */
  settle<T>(tree: T, doc: unknown): T {
    return this.provenance.settle(tree, doc);
  }

  resolveRef(ref: string, scope: EvalRoots): unknown {
    const { root, path } = parseRef(ref);
    let base = rootFor(root, scope);
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
      // A bare `.` on a `:param` (a rule on the param itself) reads its fill;
      // re-evaluating it would look the fill up by a path validation lacks.
      return this.evaluate(RecordNode.isParam(base) ? this.derefValue(base) : base, scope);
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
    if (RecordNode.isAnnotated(rawTarget)) return rawTarget[PARAM_VALUE_KEY];
    return rawTarget;
  }

  /**
   * Walks the raw tree with function-key awareness, but expression strings met
   * along the path evaluate first so refs can descend through them (e.g. into a `$tmpl('…')` table).
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

  private hooks(scope: EvalRoots, labels: Record<string, unknown>[]): ResolveHooks {
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
        const base = rootFor(root, scope);
        const next = this.write(base, root, path, value, op, scope, this.journal.rolledSince(mark));
        mark = this.journal.mark();
        return next;
      },
      assignEach: (ref: string, expr: string, op: AssignOp) => {
        const { root, path } = parseRef(ref);
        const base = rootFor(root, scope);
        for (const target of this.expandPaths(base, path, scope)) {
          const owner = getPath(base, target.slice(0, -1));
          if (owner === null || typeof owner !== 'object') continue;
          const before = this.journal.mark();
          const value = this.evalExpr(expr, { ...scope, current: owner });
          this.write(base, root, target, value, op, scope, this.journal.rolledSince(before));
        }
        mark = this.journal.mark();
      },
      label: (label: string, value: unknown) => {
        labels.push({ [LABEL_KEY]: label, [PARAM_VALUE_KEY]: value });
        return value;
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
    const slot = ownerOf(base, path);
    if (slot) {
      const kind = op === '=' ? SET_KEY : op === '+' ? ADD_KEY : SUBTRACT_KEY;
      amount = this.journal.record(slot.owner, slot.key, kind, deepClone(amount), {
        source: scope.source,
        origin: this.fieldSource(slot.owner, slot.key),
        at: scope.at,
        // Only the call's own assignments: lazy patch writes it triggers are not its doing.
        cause: this.journal.cause,
        rolled,
        calculation: this.journal.calculation,
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
    const { labels = [], ...inner } = scope;
    const run = compileBody(trimmed, Object.keys(inner.params ?? {}));
    const formula = formulaOf(trimmed);
    return this.journal.calculate(formula === undefined ? undefined : { formula, parts: labels }, () =>
      run(this.hooks(inner, labels), inner.params ?? {}),
    );
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
      if (this.patcher.expandCalls(raw, scope)) this.cache.clear();
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
    if (typeof raw !== 'string' || !ExpressionNode.matches(raw)) return this.evaluate(raw, scope);
    if (Object.keys(scope.params ?? {}).length > 0) return this.evaluateLabelled(record, key, raw, scope);
    const memo = `field|${this.idOf(scope.home ?? scope.doc)}|${this.idOf(scope.actor)}|${this.idOf(record)}|${key}`;
    if (this.cache.has(memo)) return this.cache.get(memo);
    const value = this.journal.evaluating(record, key, () => this.evaluateLabelled(record, key, raw, scope));
    this.cache.set(memo, value);
    return value;
  }

  /** Evaluate an expression field, keeping the `[Label](…)` parts it evaluated. */
  private evaluateLabelled(record: object, key: string, raw: string, scope: EvalRoots): unknown {
    const labels: Record<string, unknown>[] = [];
    const value = this.evaluate(raw, { ...scope, labels });
    const fields = this.parts.get(record) ?? new Map<string, Record<string, unknown>[]>();
    fields.set(key, labels);
    this.parts.set(record, fields);
    return value;
  }

  /** `{ :formula, :parts }` for an expression field with `[Label](…)` tags,
   * else undefined. A tag its expression skipped (`a ? [X](b) : c`) has no part. */
  labelsFor(record: object, key: string, raw: unknown): Record<string, unknown> | undefined {
    const formula = typeof raw === 'string' && ExpressionNode.matches(raw) ? formulaOf(raw) : undefined;
    if (formula === undefined) return undefined;
    return { [FORMULA_KEY]: formula, [PARTS_KEY]: this.parts.get(record)?.get(key) ?? [] };
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
    if (this.patcher.expandCalls(raw, scope)) this.cache.clear();
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
    const scope: EvalRoots = { doc: raw, actor: raw, app: this.appRoot, current: raw };
    this.patcher.expandCalls(raw, scope);
    return RecordNode.collectParams(raw, this.namespaceOf, [], this.optionsAt(scope));
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
        const slot = ownerOf(base, path);
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
    // Actors an invoke wrote in (`$.party[name] = $tmpl(…)`) declare their
    // namespaces through the recorded writes.
    const written = events
      .filter(isWriteEvent)
      .map((event) => (typeof event.value === 'string' ? event.value.trim().match(TEMPLATE_CALL)?.[2] : undefined))
      .filter((namespace) => namespace !== undefined);
    const run = this.journal.begin(actorRaw, events, inputs);
    return Die.within(run, () => this.resolveInputs(actorRaw, inputs, written));
  }

  private resolveInputs(
    actorRaw: unknown,
    given: InputEvent[],
    written: string[],
  ): { data: unknown; result?: unknown } | { query: MissingParam[] } {
    let inputs = given;
    let keyed = this.splitNamespaced(actorRaw, inputs, written);
    this.applyOverrides(actorRaw, keyed.inputs);
    const scope: EvalRoots = { doc: actorRaw, actor: actorRaw, app: this.appRoot, current: actorRaw, ...keyed };
    this.patcher.expandCalls(actorRaw, scope);
    this.applyOverrides(actorRaw, keyed.inputs);
    this.shareWithApp(actorRaw);
    const outstanding = RecordNode.collectParams(actorRaw, this.namespaceOf, inputs, this.optionsAt(scope));
    if (outstanding.length > 0) return { query: outstanding };
    const invokes = keyed.inputs.filter((event) => event.type === 'invoke');
    if (invokes.length === 0) return { data: debug(this.evaluate(actorRaw, scope)) };
    // The expansion `evaluate` would run: it re-applies nested actors'
    // overrides over the mixins that wrote under them.
    this.patcher.expandCalls(actorRaw, scope);
    RecordNode.materializeParams(actorRaw, keyed.inputs, this.namespaceOf);
    this.cache.clear();
    let result: unknown;
    for (const event of invokes) {
      result = this.invoke(event, { ...scope, ...keyed, path: [] });
      inputs = this.startFresh(event, inputs);
      // An actor the call wrote in reads its namespace's events as it expands.
      keyed = this.splitNamespaced(actorRaw, inputs, written);
      // A set given after the invoke still wins over what the call wrote,
      // nested actors included; earlier sets must not undo the call. Every
      // parameter counts, so an actor the call wrote in fills its choices.
      const after = (events: InputEvent[]) =>
        events.filter((e) => e.type === 'parameter' || inputs.indexOf(e) > inputs.indexOf(event));
      const later = { inputs: after(keyed.inputs), namespaced: after(keyed.namespaced) };
      this.applyOverrides(actorRaw, later.inputs);
      // An actor the call wrote in expands with its mixins; a second pass
      // puts its overrides back over what they wrote.
      if (this.patcher.expandCalls(actorRaw, { ...scope, ...later }))
        this.patcher.expandCalls(actorRaw, { ...scope, ...later });
      // Filled now, so a later invoke into that actor reads its choices.
      RecordNode.materializeParams(actorRaw, keyed.inputs, this.namespaceOf);
      this.cache.clear();
    }
    // An actor an invoke wrote in brings its own params: ask for them.
    const settled = { ...scope, ...keyed };
    RecordNode.materializeParams(actorRaw, keyed.inputs, this.namespaceOf);
    const asked = RecordNode.collectParams(actorRaw, this.namespaceOf, inputs, this.optionsAt(settled));
    if (asked.length > 0) return { query: asked };
    // Already expanded: a fresh expansion would re-apply every set.
    return { data: debug(this.evaluate(actorRaw, { ...settled, path: [] })), result: debug(result) ?? null };
  }

  /** An actor `event`'s call wrote in starts fresh: the inputs given for its
   * path (or namespace) before the call, and the rolls recorded there before
   * it, belonged to whatever it replaced. */
  private startFresh(event: InputEvent, inputs: InputEvent[]): InputEvent[] {
    const fresh = this.journal.writtenActors(event);
    if (fresh.length === 0) return inputs;
    for (const { path } of fresh) this.journal.forgetRolls(path, event.version);
    const at = inputs.indexOf(event);
    const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}.`);
    return inputs.filter(
      (input, index) =>
        index > at ||
        input.type === 'invoke' ||
        !fresh.some(
          ({ path, namespace }) => under(input.path, path) || (namespace !== undefined && under(input.path, namespace)),
        ),
    );
  }

  /** Computed `:options` for the param at a tree path, evaluated as a field
   * there would be: `.` its record, `#` and `@` the actor holding it. */
  private optionsAt(scope: EvalRoots): (at: string[]) => unknown {
    return (at) => {
      const param = getPath(scope.actor, at) as Record<string, unknown>;
      const nested = this.nestedActorOn(scope.actor, at, scope);
      const inner = nested === undefined ? scope : this.enterActor(nested.actor, scope, at.slice(0, nested.depth));
      return this.evalExpr(String(param[OPTIONS_KEY]), { ...inner, current: parentOf(scope.actor, at) });
    };
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
   * path-addressed ones. Namespaces are found by scanning loaded documents and
   * the tree, so the split happens before expansion creates the actors that
   * hold them; `written` adds those a replayed invoke wrote in. */
  private splitNamespaced(
    root: unknown,
    events: InputEvent[],
    written: string[] = [],
  ): { inputs: InputEvent[]; namespaced: InputEvent[] } {
    const declared = new Set<string>(written);
    const scan = (node: unknown): void => {
      if (typeof node === 'string') {
        const namespace = node.trim().match(TEMPLATE_CALL)?.[2];
        if (namespace !== undefined) declared.add(namespace);
      } else if (node !== null && typeof node === 'object') Object.values(node).forEach(scan);
    };
    this.docs.forEach(scan);
    // Actors written in by an invoke: the call as written, then the actor it expands to.
    scan(root);
    for (const namespace of this.provenance.namespacesIn(root)) declared.add(namespace);
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
    return this.patcher.applyRaw(actorRaw, patch, source, inputs);
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
      // A written-in actor logs the call that made it, not its whole tree.
      if (typeof event[kind] === 'string' && TEMPLATE_CALL.test(event[kind].trim())) return event;
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
