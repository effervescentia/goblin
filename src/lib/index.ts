/** Goblin standard library (`$lib.…`): one file per namespace, listed in
 * `NATIVE_LIB`, extended by `./lib.yaml` but never overridden by it. */
import { DICE_LIB } from './dice';
import { LIST_LIB } from './list';
import { MATH_LIB } from './math';
import { SET_LIB } from './set';

/** Native namespaces, by the name they answer to under `$lib`. */
const NATIVE_LIB: Record<string, Record<string, unknown>> = {
  dice: DICE_LIB,
  list: LIST_LIB,
  math: MATH_LIB,
  set: SET_LIB,
};

/** A fresh library table: `record`'s entries with the natives layered on top. */
export function withNatives(record: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };
  for (const [namespace, natives] of Object.entries(NATIVE_LIB)) {
    const existing = out[namespace];
    const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
    out[namespace] = { ...base, ...natives };
  }
  return out;
}
