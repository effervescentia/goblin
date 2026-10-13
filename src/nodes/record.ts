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
      if (isBareSigil(key) || key === '$') continue; // `$: Player` type tag
      if (isMetaKey(key)) {
        out[key] = value;
        continue;
      }
      if (isValidateKey(key)) {
        out[key] = value;
        continue;
      }
      if (key === '$if' || key === '$then') {
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
    if (record[':param']) {
      const marker = record[':param'];
      const paramKey = typeof marker === 'string' && marker ? marker : base.join('.');
      const provided = scope.provided?.[paramKey];
      if (provided === undefined) {
        out['value'] = null;
      } else {
        const filled = engine.evaluate(provided, scope);
        const type = record[':type'];
        if (typeof type === 'string' && type) checkParamType(type, filled, paramKey);
        out['value'] = filled;
      }
    }
    return out;
  }
}
