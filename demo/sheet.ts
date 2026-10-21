/**
 * Reading a resolved character out of the engine's `data`, metadata and all:
 * params and evented fields carry their value under `:value`, labels under `:label`.
 */
import type { MissingParam } from '@/nodes/record';

export const ENTRY = '5e/main.yaml';

/** Where `aria` sits in the resolved tree; invokes need this full path, while params go by their alias. */
export const CHARACTER = 'party.aria';

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A field's plain value, unwrapped from `{ :value, … }` when it has one. */
export function unwrap(node: unknown): unknown {
  return isRecord(node) && ':value' in node ? node[':value'] : node;
}

/** The record at `path` under `node`, unwrapping each step. */
export function at(node: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((parent, key) => (isRecord(parent) ? unwrap(parent[key]) : undefined), node);
}

/** A record's own fields: no metadata (`:label`), validation (`!validate`) or private (`_x`) keys. */
export function fields(node: unknown): [string, unknown][] {
  if (!isRecord(node)) return [];
  return Object.entries(node).filter(([key]) => !/^[:!_]/.test(key));
}

/** `all_armor` → `All armor`. */
export const humanize = (name: string) => {
  const words = name.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A field's `:label`, or its key made readable. */
export const labelOf = (node: unknown, key: string) =>
  isRecord(node) && typeof node[':label'] === 'string' ? node[':label'] : humanize(key);

export const signed = (n: unknown) => (typeof n === 'number' && n >= 0 ? `+${n}` : String(n));

/** What a form control's raw text means for `param`; undefined while it is left blank. */
export function parseParam(param: MissingParam, raw: string): unknown {
  if (raw === '') return undefined;
  if (param.type === 'integer' || param.type === 'number') return Number(raw);
  if (param.type === 'boolean') return raw === 'true';
  if (param.type === 'array' || param.type === 'record') return JSON.parse(raw);
  return raw;
}
