import { PARAM_VALUE_KEY } from '@/constants';

/** The picks a value holds — a `:param` record's `:value`, never its
 * `:options`, which are offered rather than taken. */
export function picksOf(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(picksOf);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (PARAM_VALUE_KEY in record) return picksOf(record[PARAM_VALUE_KEY]);
    return Object.values(record).flatMap(picksOf);
  }
  return [value];
}

/** `$lib.list` — reading choices back out, so documents can turn picks into
 * numbers. */
export const LIST_LIB: Record<string, (...args: never[]) => number> = {
  /** How many times `item` was picked. */
  count: ((value: unknown, item: unknown) => picksOf(value).filter((pick) => pick === item).length) as never,
  /** 1 when picked at all, else 0 — expressions do arithmetic on that. */
  has: ((value: unknown, item: unknown) => (picksOf(value).includes(item) ? 1 : 0)) as never,
  /** How many picks were made in total. */
  size: ((value: unknown) => picksOf(value).length) as never,
};
