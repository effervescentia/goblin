import { PARAM_VALUE_KEY } from '@/constants';
import { isMetaKey } from '@/utils';
import { picksOf } from './list';

/** A record's data keys, never its metadata. */
function keysOf(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => !isMetaKey(key));
}

/** A field's own value, seeing through a `{ :value, :events }` pair. */
function fieldValue(value: unknown): unknown {
  return value !== null && typeof value === 'object' && PARAM_VALUE_KEY in value
    ? (value as Record<string, unknown>)[PARAM_VALUE_KEY]
    : value;
}

/** `$lib.record` — records as tables keyed by name: a combat's members are
 * the party's keys, and its initiative a record of their rolls. */
export const RECORD_LIB: Record<string, (...args: never[]) => unknown> = {
  /** The record's keys, in order. */
  keys: ((record: unknown) => keysOf(record)) as never,
  /** The record's values, in key order: a table's rows as a list. */
  values: ((record: unknown) => keysOf(record).map((key) => (record as Record<string, unknown>)[key])) as never,
  /** A record keyed by each pick, holding `fn` called with it. */
  from: ((keys: unknown, fn: unknown) => {
    if (typeof fn !== 'function') throw new Error('$lib.record.from: expected a function');
    return Object.fromEntries(picksOf(keys).map((key) => [String(key), fn(key)]));
  }) as never,
  /** The keys, highest value first. A tie goes to the higher value in each
   * `tiebreaks` record in turn, then keeps its order. */
  rank: ((record: unknown, ...tiebreaks: unknown[]) => {
    const score = (table: unknown, key: string) =>
      Number(fieldValue(table !== null && typeof table === 'object' ? (table as Record<string, unknown>)[key] : 0));
    return keysOf(record)
      .map((key, index) => ({ key, index, values: [record, ...tiebreaks].map((table) => score(table, key)) }))
      .sort((a, b) => a.values.reduce((by, value, i) => by || (b.values[i] ?? 0) - value, 0) || a.index - b.index)
      .map(({ key }) => key);
  }) as never,
};
