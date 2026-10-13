import {
  COUNT_KEY,
  DEFAULT_KEY,
  DOC_KEY,
  DOCUMENT,
  FUNCTION_KEY,
  IF_KEY,
  OPTIONS_KEY,
  PARAM_KEY,
  PARAM_VALUE_KEY,
  SOURCE_KEY,
  THEN_KEY,
  TYPE_KEY,
  UNIQUE_KEY,
  VALIDATE_KEY,
  VALUE_KEY,
} from '../constants';
import type { GoblinEngine } from '../engine';
import type { EvalRoots } from '../utils';
import { isBareSigil, isMetaKey, isPathKey, isValidateKey, stripPlus } from '../utils';
import { Die } from './die';
import { FunctionNode } from './function';
import { Node } from './node';

export interface MissingParam {
  /** Dotted path of the node needing a value (`:param` alias when given). */
  path: string;
  /** The node's `:doc`, when attached. */
  doc?: string;
  /** The node's declared `:type`, when given. */
  type?: string;
  /** The node's allowed values (`:options`), when declared. */
  options?: unknown[];
  /** The node's required item count (`:count`), when declared. */
  count?: number;
  /** Present when the node requires distinct array items (`:unique: true`). */
  unique?: boolean;
}

export class RecordNode extends Node<Record<string, unknown>> {
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
   * item must equal one); `:unique: true` requires distinct array items;
   * `:count` requires an exact array length. Malformed declarations throw
   * even when the value is absent; `:unique`/`:count` ignore non-array values.
   */
  static checkParamConstraints(record: Record<string, unknown>, value: unknown, path: string): void {
    const options = record[OPTIONS_KEY];
    if (options !== undefined && !Array.isArray(options)) {
      throw new Error(`invalid :options for ${path}: expected array, got ${describeValue(options)}`);
    }
    const count = record[COUNT_KEY];
    if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count) || count < 0)) {
      throw new Error(`invalid :count for ${path}: expected non-negative integer, got ${describeValue(count)}`);
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

  /** Every `:param` record in a raw tree, as `[{ path, doc?, type?, … }]`. */
  static collectParams(raw: unknown): MissingParam[] {
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
      const options = record[OPTIONS_KEY];
      if (Array.isArray(options)) entry.options = [...options];
      const count = record[COUNT_KEY];
      if (typeof count === 'number') entry.count = count;
      if (record[UNIQUE_KEY] === true) entry.unique = true;
      missing.push(entry);
    });
    return missing;
  }

  /**
   * Fill raw `:param` records with `value` slots (provided, else `:default`,
   * else `null`) so `<path>.value` references resolve like any other node.
   * Returns true when anything was written. Idempotent.
   */
  static materializeParams(raw: unknown, provided: Record<string, unknown> = {}): boolean {
    let wrote = false;
    eachParamRecord(raw, (record, key) => {
      const def = record[DEFAULT_KEY];
      const hasDefault = def !== undefined && def !== null;
      record[VALUE_KEY] = provided[key] !== undefined ? provided[key] : hasDefault ? def : null;
      wrote = true;
    });
    return wrote;
  }

  /** Printed form: entry-wise, through the caller's `each` for recursion. */
  static serialize(record: Record<string, unknown>, each: (value: unknown) => unknown): Record<string, unknown> {
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, each(value)]));
  }

  /**
   * Recursively drop metadata keys (`:…` and `!validate`) from resolved
   * output. `:param` records collapse to their `:value`; serialized functions
   * (`{ :type: 'function', :source, … }`) print as their source expression;
   * other records left empty (e.g. `{ :doc }`) collapse to `null`. Arrays are
   * mapped item-wise; scalars pass through.
   */
  static stripMetadata(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(RecordNode.stripMetadata);
    if (value && typeof value === 'object') {
      const rec = value as Record<string, unknown>;
      if (RecordNode.isParam(rec)) {
        return RecordNode.stripMetadata(rec[PARAM_VALUE_KEY] ?? null);
      }
      if (rec[TYPE_KEY] === 'function' && typeof rec[SOURCE_KEY] === 'string') {
        return rec[SOURCE_KEY];
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) {
        if (isMetaKey(k) || isValidateKey(k)) continue;
        out[k] = RecordNode.stripMetadata(v);
      }
      return Object.keys(out).length === 0 ? null : out;
    }
    return value;
  }

  override evaluate(engine: GoblinEngine, scope: EvalRoots): unknown {
    const record = this.raw;
    if (record[PARAM_KEY]) {
      return fillParam(engine, record, scope, scope.path ?? []);
    }
    const base = scope.path ?? [];
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (isBareSigil(key) || key === DOCUMENT) continue; // `$: Player` type tag
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
        out[fn.name] = fn.evaluate(engine, scope);
        continue;
      }
      if (key.startsWith('+')) {
        out[key.slice(1)] = engine.evaluate(value, { ...scope, current: record, path: [...base, key.slice(1)] });
        continue;
      }
      if (isPathKey(key)) continue; // patch instruction — handled by apply()
      out[key] = engine.evaluate(value, { ...scope, current: record, path: [...base, key] });
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

/**
 * A `:param` record evaluates to its declaration metadata plus a `:value`
 * slot holding the filled value — provided, else `:default`, else `null`.
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
  const provided = scope.provided?.[paramKey];
  const def = record[DEFAULT_KEY];
  if (provided === undefined && (def === undefined || def === null)) {
    out[PARAM_VALUE_KEY] = null;
    return out;
  }
  const filled = engine.evaluate(provided !== undefined ? provided : def, scope);
  const type = record[TYPE_KEY];
  if (typeof type === 'string' && type) RecordNode.checkParamType(type, filled, paramKey);
  RecordNode.checkParamConstraints(record, filled, paramKey);
  out[PARAM_VALUE_KEY] = filled;
  return out;
}
