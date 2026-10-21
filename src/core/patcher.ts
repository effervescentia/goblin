/**
 * Applied documents: merging a patch (a class file, a `$mixin`, a `$then`
 * block) into an actor's raw tree, filing every write in the journal, and
 * expanding calls written as plain values so the nodes they return land in
 * the tree.
 */
import {
  ACTOR,
  ACTOR_KEY,
  ADD_KEY,
  CALL_EXPR,
  IF_KEY,
  MIXIN_CALL,
  SET_KEY,
  TEMPLATE_CALL,
  THEN_KEY,
} from '@/constants';
import type { InputEvent } from '@/inputs';
import { isNativeCall } from '@/lib';
import { Die } from '@/nodes/die';
import { FunctionNode } from '@/nodes/function';
import { RecordNode } from '@/nodes/record';
import {
  deepClone,
  type EvalRoots,
  getPath,
  isBareSigil,
  isMetaKey,
  isPathKey,
  isValidateKey,
  ownerOf,
  parseRef,
  rootFor,
  setPath,
  stripPlus,
} from '@/utils';
import type { GoblinEngine } from './engine';
import type { Journal } from './journal';
import type { Provenance } from './provenance';

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

export class Patcher {
  constructor(
    private readonly engine: GoblinEngine,
    private readonly journal: Journal,
    private readonly provenance: Provenance,
  ) {}

  /** Apply an in-memory patch (e.g. a `$tmpl('…')` clone) onto an actor.
   * `source` names it in the event logs; defaults to the document it came from. */
  applyRaw(actorRaw: unknown, patch: unknown, source?: string, inputs?: InputEvent[]): unknown {
    const scope: EvalRoots = {
      doc: patch,
      actor: actorRaw,
      app: this.engine.appRoot,
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

  /** A patch value that is one call to a definition (`$tmpl('…')`,
   * `$.feature.x()`) inlines here, so `:param` nodes inside it land in the
   * actor tree instead of staying an expression. Calls that yield anything
   * but a record, or to a `$lib` native, stay as written, and so stay lazy. */
  private inlinePatchValue(value: unknown, scope: EvalRoots): unknown {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!CALL_EXPR.test(trimmed) || isNativeCall(trimmed)) return value;
    try {
      // A probe: anything it rolls is thrown away with a non-record result,
      // so it rolls scratch dice rather than taking the field's.
      const inlined = Die.within({ roll: Die.fresh }, () => this.engine.evalExpr(trimmed, scope));
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
    const doc = this.engine.docs.get(file);
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
    RecordNode.materializeParams(actor, scope.inputs, this.provenance.namespaceOf);
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
      const nested = this.engine.isNestedActor(record, outer);
      const inner = nested ? this.engine.enterActor(record, outer, path) : outer;
      if (nested && inner.inputs) this.engine.applyOverrides(record, inner.inputs);
      const base = nested ? [] : path;
      for (const [key, value] of Object.entries(record)) {
        if (isMetaKey(key) || isValidateKey(key)) continue;
        if (typeof value === 'string' && MIXIN_CALL.test(value.trim())) {
          // Consumed: the mixin merges into the actor, the key stays for `$lib.record.keys`.
          record[key] = null;
          this.mixin(value, inner);
          wrote = true;
          continue;
        }
        const next = this.inlinePatchValue(value, inner);
        if (next !== value) {
          record[key] = this.provenance.claim(next, this.engine.fieldSource(record, key) ?? '');
          wrote = true;
        }
        visit(record[key], inner, [...base, key]);
      }
    };
    visit(raw, scope, []);
    this.provenance.assertUniqueNamespaces(raw);
    return wrote;
  }

  /**
   * A `$if` wrapper gates its whole node: false applies nothing (not even
   * `:meta`), so gated-out content leaves no residue. Missing or empty
   * `$if` (comment-only `null`) counts as unconditional.
   */
  private condPasses(value: Record<string, unknown>, scope: EvalRoots): boolean {
    if (!(IF_KEY in value)) return true;
    const rawCond = value[IF_KEY];
    return rawCond == null || rawCond === '' ? true : Boolean(this.engine.evaluate(rawCond, scope));
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
    const base = rootFor(root, scope);
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
      const slot = ownerOf(base, path);
      if (slot) this.journal.seed(slot.owner, slot.key); // before the append, not after
      let target = getPath(base, path);
      if (!Array.isArray(target)) {
        setPath(base, path, []);
        target = getPath(base, path);
      }
      this.applyArrayWrite(target as unknown[], value, slot, pathKey);
      return;
    }
    const slot = ownerOf(base, path);
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
      this.mixin(rawValue, scope);
      if (!(key in target)) target[key] = null;
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
      if (typeof target[k] !== 'object' || target[k] === null || Array.isArray(target[k])) target[k] = {};
      this.mergeInto(target[k], value, { ...scope, current: target[k] });
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
}
