/** Goblin standard library (`$lib.…`): one file per namespace, listed in
 * `NATIVE_LIB`, extended by `./lib.yaml` but never overridden by it. */
import { LIST_LIB } from './list';
import { MATH_LIB } from './math';

export { LIST_LIB } from './list';
export { MATH_LIB } from './math';

/** Native namespaces, by the name they answer to under `$lib`. */
export const NATIVE_LIB: Record<string, Record<string, unknown>> = {
  list: LIST_LIB,
  math: MATH_LIB,
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
