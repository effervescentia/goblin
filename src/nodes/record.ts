import {
  ACTOR_KEY,
  COUNT_KEY,
  DEFAULT_KEY,
  DOC_KEY,
  EVENTS_KEY,
  FUNCTION_KEY,
  IF_KEY,
  LABEL_KEY,
  MAX_KEY,
  MIN_KEY,
  OPTIONS_KEY,
  PARAM_KEY,
  PARAM_VALUE_KEY,
  PARTS_KEY,
  SOURCE_KEY,
  THEN_KEY,
  TYPE_KEY,
  UNIQUE_KEY,
  VALIDATE_KEY,
  VALUE_KEY,
} from '@/constants';
import type { GoblinEngine } from '@/core/engine';
import { type InputEvent, paramValue } from '@/inputs';
import type { EvalRoots } from '@/utils';
import { isBareSigil, isMetaKey, isPathKey, isPrivateKey, isValidateKey, stripPlus } from '@/utils';
import { Die } from './die';
import { FunctionNode } from './function';
import { Node } from './node';

export interface MissingParam {
  /** Dotted path of the node needing a value (`:param` alias when given). */
  path: string;
  /** The node's `:label` — its display name — when attached. */
  label?: string;
  /** The node's `:doc`, when attached. */
  doc?: string;
  /** The node's declared `:type`, when given. */
  type?: string;
  /** The node's allowed values (`:options`), when declared. */
  options?: unknown[];
  /** The node's inclusive lower bound (`:min`), when declared. */
  min?: number;
  /** The node's inclusive upper bound (`:max`), when declared. */
  max?: number;
  /** The node's required item count (`:count`), when declared. */
  count?: number;
  /** Present when the node requires distinct array items (`:unique: true`). */
  unique?: boolean;
}

export class RecordNode extends Node<Record<string, unknown>> {
  /** A field printed with its labelled parts or change history: `{ :value, :formula?, :parts?, :events? }`. */
  static isAnnotated(node: unknown): node is Record<string, unknown> {
    return (
      typeof node === 'object' && node !== null && PARAM_VALUE_KEY in node && (EVENTS_KEY in node || PARTS_KEY in node)
    );
  }

  /** Attach a field's `labels` (`{ :formula, :parts }`) and the writes that
   * produced it: a record takes them in place, everything else pairs up as
   * `{ :value, … }`. */
  static annotate(value: unknown, labels: Record<string, unknown> | undefined, events: unknown[] | undefined): unknown {
    if (labels === undefined && events === undefined) return value;
    const notes = { ...labels, ...(events === undefined ? {} : { [EVENTS_KEY]: events }) };
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Die)) {
      return { ...(value as Record<string, unknown>), ...notes };
    }
    return { [PARAM_VALUE_KEY]: value, ...notes };
  }

  /** A record declaring a user-provided value (`:param` marker present). */
  static isParam(node: unknown): node is Record<string, unknown> {
    return typeof node === 'object' && node !== null && PARAM_KEY in node;
  }

  /** Throw on unknown types or provided values of the wrong type. */
  static checkParamType(type: string, value: unknown, path: string): void {
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
   * Enforce a `:param` record's choice constraints against a filled value.
   * `:options` restricts membership (scalar must equal one entry; every array
   * item must equal one); `:min`/`:max` bound numbers inclusively (array
   * items each); `:unique: true` requires distinct array items; `:count`
   * requires an exact array length. Malformed declarations throw even when
   * the value is absent; bounds skip non-numbers, `:unique`/`:count` non-arrays.
   * Computed `:options` (an expression) check only once a caller resolves them.
   */
  static checkParamConstraints(
    record: Record<string, unknown>,
    value: unknown,
    path: string,
    options: unknown = record[OPTIONS_KEY],
  ): void {
    if (options !== undefined && !Array.isArray(options) && !RecordNode.computesOptions(options)) {
      throw new Error(`invalid :options for ${path}: expected array, got ${describeValue(options)}`);
    }
    const count = record[COUNT_KEY];
    if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count) || count < 0)) {
      throw new Error(`invalid :count for ${path}: expected non-negative integer, got ${describeValue(count)}`);
    }
    for (const key of [MIN_KEY, MAX_KEY]) {
      const bound = record[key];
      if (bound !== undefined && (typeof bound !== 'number' || Number.isNaN(bound))) {
        throw new Error(`invalid ${key} for ${path}: expected number, got ${describeValue(bound)}`);
      }
    }
    const min = record[MIN_KEY] as number | undefined;
    const max = record[MAX_KEY] as number | undefined;
    if (min !== undefined || max !== undefined) {
      const checkBounds = (item: unknown, at: string) => {
        if (typeof item !== 'number') return;
        if ((min !== undefined && item < min) || (max !== undefined && item > max)) {
          throw new Error(`param range mismatch: ${at} expected ${formatRange(min, max)}, got ${item}`);
        }
      };
      if (Array.isArray(value)) value.forEach((item, index) => checkBounds(item, `${path}[${index}]`));
      else checkBounds(value, path);
    }
    if (Array.isArray(options)) {
      const list = `[${options.map(formatOption).join(', ')}]`;
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (!options.includes(item)) {
            throw new Error(
              `param options mismatch: ${path}[${index}] expected one of ${list}, got ${formatOption(item)}`,
            );
          }
        });
      } else if (!options.includes(value)) {
        throw new Error(`param options mismatch: ${path} expected one of ${list}, got ${formatOption(value)}`);
      }
    }
    if (Array.isArray(value) && record[UNIQUE_KEY] === true) {
      const seen = new Set<unknown>();
      for (const item of value) {
        if (seen.has(item)) {
          throw new Error(`param uniqueness mismatch: ${path} has duplicate item ${formatOption(item)}`);
        }
        seen.add(item);
      }
    }
    if (typeof count === 'number' && Array.isArray(value) && value.length !== count) {
      throw new Error(`param count mismatch: ${path} expected ${count} items, got ${value.length}`);
    }
  }

  /** Whether `:options` is an expression, resolved where the param lives. */
  static computesOptions(options: unknown): options is string {
    return typeof options === 'string';
  }

  /** Every `:param` record in a raw tree, as `[{ path, doc?, type?, … }]`.
   * A namespaced actor's params report under its namespace (`aria.name`);
   * params an `inputs` parameter event fills by either key are left out.
   * `optionsAt` resolves computed `:options` from the param's tree path. */
  static collectParams(
    raw: unknown,
    namespaceOf?: (record: object) => string | undefined,
    inputs: readonly InputEvent[] = [],
    optionsAt?: (at: string[]) => unknown,
  ): MissingParam[] {
    const missing: MissingParam[] = [];
    eachParamRecord(
      raw,
      (record, key, full, at) => {
        const def = record[DEFAULT_KEY];
        if (def !== undefined && def !== null) return; // satisfied by default
        if (paramValue(inputs, key, full) !== undefined) return;
        const entry: MissingParam = { path: key };
        const label = record[LABEL_KEY];
        if (typeof label === 'string' && label) entry.label = label;
        const doc = record[DOC_KEY];
        if (typeof doc === 'string' && doc) entry.doc = doc;
        const type = record[TYPE_KEY];
        if (typeof type === 'string' && type) {
          assertKnownParamType(type, key);
          entry.type = type;
        }
        const declared = record[OPTIONS_KEY];
        const options = RecordNode.computesOptions(declared) ? optionsAt?.(at) : declared;
        if (Array.isArray(options)) entry.options = [...options];
        const min = record[MIN_KEY];
        if (typeof min === 'number') entry.min = min;
        const max = record[MAX_KEY];
        if (typeof max === 'number') entry.max = max;
        const count = record[COUNT_KEY];
        if (typeof count === 'number') entry.count = count;
        if (record[UNIQUE_KEY] === true) entry.unique = true;
        missing.push(entry);
      },
      namespaceOf,
    );
    return missing;
  }

  /**
   * Fill raw `:param` records with `value` slots (a parameter event, else `:default`,
   * else `null`) so `<path>.value` references resolve like any other node.
   * Returns true when anything was written. Idempotent.
   */
  static materializeParams(
    raw: unknown,
    inputs: readonly InputEvent[] = [],
    namespaceOf?: (record: object) => string | undefined,
  ): boolean {
    let wrote = false;
    eachParamRecord(
      raw,
      (record, key, full) => {
        const def = record[DEFAULT_KEY];
        const hasDefault = def !== undefined && def !== null;
        const given = paramValue(inputs, key, full);
        record[VALUE_KEY] = given !== undefined ? given : hasDefault ? def : null;
        wrote = true;
      },
      namespaceOf,
    );
    return wrote;
  }

  override debug(each: (value: unknown) => unknown): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this.raw).map(([key, value]) => [key, each(value)]));
  }

  override print(each: (value: unknown) => unknown): unknown {
    const record = this.raw;
    if (RecordNode.isParam(record) || RecordNode.isAnnotated(record)) {
      return each(record[PARAM_VALUE_KEY] ?? null);
    }
    if (record[TYPE_KEY] === 'function' && typeof record[SOURCE_KEY] === 'string') return record[SOURCE_KEY];
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (isMetaKey(key) || isValidateKey(key) || isPrivateKey(key)) continue;
      out[key] = each(value);
    }
    return Object.keys(out).length === 0 ? null : out;
  }

  override evaluate(engine: GoblinEngine, outer: EvalRoots): unknown {
    const record = this.raw;
    const scope = engine.isNestedActor(record, outer) ? engine.enterActor(record, outer, outer.path ?? []) : outer;
    if (record[PARAM_KEY]) {
      return fillParam(engine, record, scope, scope.path ?? []);
    }
    const base = scope.path ?? [];
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (isBareSigil(key) || key === ACTOR_KEY) continue; // `$actor` / `@` actor declarations
      if (isMetaKey(key)) {
        out[key] = value;
        continue;
      }
      if (isValidateKey(key)) {
        out[key] = value;
        continue;
      }
      if (key === IF_KEY || key === THEN_KEY) {
        continue; // control flow — consumed by apply(), never serialized
      }
      const fn = FunctionNode.match(key, value, record);
      if (fn) {
        const source = engine.fieldSource(record, key);
        out[fn.name] = fn.evaluate(engine, { ...scope, source, at: engine.locationOf(record, key) });
        continue;
      }
      if (isPathKey(key)) continue; // patch instruction (incl. `+@.x`) — handled by apply()
      if (key.startsWith('+')) {
        const added = key.slice(1);
        out[added] = engine.evaluate(value, { ...scope, current: record, path: [...base, added] });
        continue;
      }
      const fieldScope = { ...scope, current: record, path: [...base, key] };
      const evaluated = engine.evaluateField(record, key, value, fieldScope);
      // A labelled field prints its parts; one a patch wrote, its history, each write resolved.
      out[key] = RecordNode.annotate(
        evaluated,
        engine.labelsFor(record, key, value),
        engine.resolvedEventsFor(record, key, evaluated, fieldScope),
      );
    }
    return out;
  }
}

const PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'die', 'array', 'record'] as const;

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Die) return 'die';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Throw on undeclared type names. */
function assertKnownParamType(type: string, path: string): void {
  if (!(PARAM_TYPES as readonly string[]).includes(type)) {
    throw new Error(`unknown param type: ${type} (at ${path})`);
  }
}

/** Render `:min`/`:max` for `param range mismatch` messages. */
function formatRange(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return `${min} to ${max}`;
  return min !== undefined ? `at least ${min}` : `at most ${max}`;
}

/** Render a value for `param options mismatch` messages (JSON, falling back to String). */
function formatOption(value: unknown): string {
  try {
    const rendered = JSON.stringify(value);
    return typeof rendered === 'string' ? rendered : String(value);
  } catch {
    return String(value);
  }
}

/**
 * Structural walk visiting every `:param` record with its dotted path (or
 * `:param` alias). Patch instructions (`@.…` keys) are not descended —
 * params belong in actor-defining (or merged) trees.
 */
function eachParamRecord(
  raw: unknown,
  visit: (record: Record<string, unknown>, key: string, full: string, at: string[]) => void,
  namespaceOf?: (record: object) => string | undefined,
): void {
  // `path` restarts at each namespaced actor below the root; `full` never does.
  const visitNode = (node: unknown, at: string[], full: string[]) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visitNode(item, [...at, String(index)], [...full, String(index)]));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const namespace = node === raw ? undefined : namespaceOf?.(record);
    const path = namespace === undefined ? at : [namespace];
    const marker = record[PARAM_KEY];
    if (marker) {
      const alias = typeof marker === 'string' && marker ? marker : undefined;
      visit(record, alias ?? path.join('.'), alias ?? full.join('.'), full);
    }
    for (const [key, value] of Object.entries(record)) {
      if (
        key === PARAM_KEY ||
        key === DOC_KEY ||
        key === LABEL_KEY ||
        key === TYPE_KEY ||
        key === VALIDATE_KEY ||
        key === IF_KEY ||
        key === THEN_KEY
      )
        continue;
      if (isBareSigil(key) || key === ACTOR_KEY || isPathKey(key)) continue;
      // A definition's body holds params for its calls, not for this tree.
      if (FUNCTION_KEY.test(key)) continue;
      visitNode(value, [...path, stripPlus(key)], [...full, stripPlus(key)]);
    }
  };
  visitNode(raw, [], []);
}

/**
 * A `:param` record evaluates to its declaration metadata plus a `:value`
 * slot holding the filled value — a parameter event, else `:default`, else `null`.
 * Bare refs still read the filled value directly (see `derefParam`); the
 * wrapper is display only, and `--strip-metadata` collapses it to `:value`.
 */
function fillParam(engine: GoblinEngine, record: Record<string, unknown>, scope: EvalRoots, base: string[]): unknown {
  const marker = record[PARAM_KEY];
  const paramKey = typeof marker === 'string' && marker ? marker : base.join('.');
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isMetaKey(key) || isValidateKey(key)) out[key] = value;
  }
  const declared = record[OPTIONS_KEY];
  const options = RecordNode.computesOptions(declared) ? engine.evalExpr(declared, scope) : declared;
  if (options !== undefined) out[OPTIONS_KEY] = options;
  const provided = paramValue(scope.inputs, paramKey);
  const def = record[DEFAULT_KEY];
  if (provided === undefined && (def === undefined || def === null)) {
    out[PARAM_VALUE_KEY] = null;
    return out;
  }
  const filled = engine.evaluate(provided !== undefined ? provided : def, scope);
  const type = record[TYPE_KEY];
  if (typeof type === 'string' && type) RecordNode.checkParamType(type, filled, paramKey);
  RecordNode.checkParamConstraints(record, filled, paramKey, options);
  out[PARAM_VALUE_KEY] = filled;
  return out;
}
