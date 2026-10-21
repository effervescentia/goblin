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

/** A labelled field's `:formula`, and each `[Label](…)` part's value (`Dexterity +2`). */
export function formulaAt(node: unknown, path: string): { formula: string; parts: string[] } | undefined {
  const keys = path.split('.');
  const parent = keys.length > 1 ? at(node, keys.slice(0, -1).join('.')) : node;
  const field = isRecord(parent) ? parent[keys.at(-1) ?? ''] : undefined;
  if (!isRecord(field) || typeof field[':formula'] !== 'string') return undefined;
  const parts = Array.isArray(field[':parts']) ? field[':parts'] : [];
  return {
    formula: field[':formula'],
    parts: parts.filter(isRecord).map((part) => `${String(part[':label'])} ${signed(part[':value'])}`),
  };
}

export const signed = (n: unknown) => (typeof n === 'number' && n >= 0 ? `+${n}` : String(n));

/** What a form control's raw text means for `param`; undefined while it is left blank. */
export function parseParam(param: MissingParam, raw: string): unknown {
  if (raw === '') return undefined;
  if (param.type === 'integer' || param.type === 'number') return Number(raw);
  if (param.type === 'boolean') return raw === 'true';
  if (param.type === 'array' || param.type === 'record') return JSON.parse(raw);
  return raw;
}

/** How many controls `param` takes: an exact count may repeat a pick (the same ability twice), so one select each. */
export const slotsOf = (param: MissingParam) =>
  param.options && param.type === 'array' ? (param.count ?? param.options.length) : 1;

/** The value `param`'s controls hold — selects hold an option's index — or undefined until every one is filled. */
export function readParam(param: MissingParam, raw: (string | undefined)[]): unknown {
  const { options } = param;
  if (!options) return parseParam(param, raw[0] ?? '');
  const picks = Array.from({ length: slotsOf(param) }, (_, i) => raw[i] || undefined);
  if (picks.some((pick) => pick === undefined)) return undefined;
  const values = picks.map((pick) => options[Number(pick)]);
  return param.type === 'array' ? values : values[0];
}
