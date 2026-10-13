import { DEFAULT_KEY, DOCUMENT, IF_KEY, PARAM_KEY, PARAM_VALUE_KEY, THEN_KEY, TYPE_KEY } from '../constants';
import type { GoblinEngine } from '../engine';
import type { EvalRoots } from '../utils';
import {
  checkParamConstraints,
  checkParamType,
  isBareSigil,
  isMetaKey,
  isPathKey,
  isValidateKey,
  stripPlus,
} from '../utils';
import { FunctionNode } from './function';
import { Node } from './node';

export class RecordNode extends Node<Record<string, unknown>> {
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
  if (typeof type === 'string' && type) checkParamType(type, filled, paramKey);
  checkParamConstraints(record, filled, paramKey);
  out[PARAM_VALUE_KEY] = filled;
  return out;
}
