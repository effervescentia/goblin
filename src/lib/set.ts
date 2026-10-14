import { picksOf } from './list';

/** Distinct picks, in order of first appearance. */
function members(value: unknown): unknown[] {
  return [...new Set(picksOf(value))];
}

/** `$lib.set` — lists as sets, reading picks the way `$lib.list` does. */
export const SET_LIB: Record<string, (...args: never[]) => unknown> = {
  union: ((a: unknown, b: unknown) => members([picksOf(a), picksOf(b)])) as never,
  intersection: ((a: unknown, b: unknown) => {
    const other = picksOf(b);
    return members(a).filter((item) => other.includes(item));
  }) as never,
  /** In `a`, not in `b`. */
  difference: ((a: unknown, b: unknown) => {
    const other = picksOf(b);
    return members(a).filter((item) => !other.includes(item));
  }) as never,
  /** 1 when every item of `a` is in `b`, else 0 — numbers, like `list.has`. */
  subset: ((a: unknown, b: unknown) => {
    const other = picksOf(b);
    return picksOf(a).every((item) => other.includes(item)) ? 1 : 0;
  }) as never,
};
