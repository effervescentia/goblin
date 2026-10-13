import { DEFAULT_KEY, DOCUMENT, IF_KEY, PARAM_KEY, THEN_KEY, TYPE_KEY, VALUE_KEY } from '../constants';
import type { GoblinEngine } from '../engine';
import type { EvalRoots } from '../utils';
import { checkParamType, isBareSigil, isMetaKey, isPathKey, isValidateKey, stripPlus } from '../utils';
import { FunctionNode } from './function';
import { Node } from './node';

export class RecordNode extends Node<Record<string, unknown>> {
  override evaluate(engine: GoblinEngine, scope: EvalRoots): unknown {
    const record = this.raw;
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
    if (record[PARAM_KEY]) {
      const marker = record[PARAM_KEY];
      const paramKey = typeof marker === 'string' && marker ? marker : base.join('.');
      const provided = scope.provided?.[paramKey];
      const def = record[DEFAULT_KEY];
      const hasDefault = def !== undefined && def !== null;
      if (provided === undefined && !hasDefault) {
        out[VALUE_KEY] = null;
      } else {
        const filled = engine.evaluate(provided !== undefined ? provided : def, scope);
        const type = record[TYPE_KEY];
        if (typeof type === 'string' && type) checkParamType(type, filled, paramKey);
        out[VALUE_KEY] = filled;
      }
    }
    return out;
  }
}
