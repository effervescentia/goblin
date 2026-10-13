/**
 * Goblin standard library — everything reachable as `$lib.…`.
 *
 * Each namespace is a table of natives bound in code (`./math`), optionally
 * extended by the yaml document in `./lib.yaml`. Natives always win over yaml
 * definitions of the same name, so documents can add to a namespace but never
 * redefine its primitives. Add a namespace by writing `./<name>.ts` and
 * listing it in `NATIVE_LIB`.
 */
import { MATH_LIB } from './math';

export { MATH_LIB } from './math';

/** Native namespaces, by the name they answer to under `$lib`. */
export const NATIVE_LIB: Record<string, Record<string, unknown>> = {
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
