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

/** A choice of any distinct options (combat's members): one checkbox per option rather than a select per pick. */
export const picksAny = (param: MissingParam) =>
  Boolean(param.options && param.type === 'array' && param.unique && param.count === undefined);

/** How many controls `param` takes: an exact count may repeat a pick (the same ability twice), so one select each. */
export const slotsOf = (param: MissingParam) =>
  param.options && param.type === 'array' ? (param.count ?? param.options.length) : 1;

/** The value `param`'s controls hold — selects hold an option's index — or undefined until every one is filled. */
export function readParam(param: MissingParam, raw: (string | undefined)[]): unknown {
  const { options } = param;
  if (!options) return parseParam(param, raw[0] ?? '');
  if (picksAny(param)) {
    const checked = options.filter((_, i) => raw[i]);
    return checked.length > 0 ? checked : undefined;
  }
  const picks = Array.from({ length: slotsOf(param) }, (_, i) => raw[i] || undefined);
  if (picks.some((pick) => pick === undefined)) return undefined;
  const values = picks.map((pick) => options[Number(pick)]);
  return param.type === 'array' ? values : values[0];
}

/** The alias `aria`'s params go by. */
const PARAMS = 'aria';

export type Template = { label: string; params: Record<string, unknown> };

/** Premade characters: an answer to every choice, by path under `PARAMS`. */
export const TEMPLATES: Template[] = [
  {
    label: 'Dwarf Fighter',
    params: {
      name: 'Brom',
      species: 'dwarf',
      class: 'fighter',
      background: 'acolyte',
      'improvements.background': ['wisdom', 'wisdom', 'intelligence'],
      ability_method: 'standard_array',
      'abilities.strength.assigned': 15,
      'abilities.dexterity.assigned': 10,
      'abilities.constitution.assigned': 14,
      'abilities.intelligence.assigned': 8,
      'abilities.wisdom.assigned': 13,
      'abilities.charisma.assigned': 12,
      'features.fighting_style': 'defense',
      'skills.trained': ['athletics', 'intimidation'],
    },
  },
  {
    label: 'Elf Ranger',
    params: {
      name: 'Elowen',
      species: 'elf',
      class: 'ranger',
      background: 'acolyte',
      'improvements.background': ['wisdom', 'wisdom', 'intelligence'],
      ability_method: 'standard_array',
      'abilities.strength.assigned': 12,
      'abilities.dexterity.assigned': 15,
      'abilities.constitution.assigned': 13,
      'abilities.intelligence.assigned': 10,
      'abilities.wisdom.assigned': 14,
      'abilities.charisma.assigned': 8,
      'skills.trained': ['perception', 'stealth', 'survival'],
    },
  },
];

/** A template's params as the inputs a `resolve` sends. */
export const templateInputs = ({ params }: Template) =>
  Object.entries(params).map(([path, value]) => ({ type: 'parameter' as const, path: `${PARAMS}.${path}`, value }));

interface Combatant {
  key: string;
  initiative: unknown;
}

export interface Combat {
  round: unknown;
  current: unknown;
  order: Combatant[];
}

/** The fight in progress at `data.combat`, in turn order; null between fights. */
export function combatOf(data: unknown): Combat | null {
  const combat = at(data, 'combat');
  if (!isRecord(combat)) return null;
  const order = at(combat, 'order');
  return {
    round: at(combat, 'round'),
    current: at(combat, 'current'),
    order: (Array.isArray(order) ? order : []).map((key) => ({
      key: String(key),
      initiative: at(combat, `initiative.${key}`),
    })),
  };
}

/** A field's `:doc`, if it has one. */
export const docOf = (node: unknown) => (isRecord(node) && typeof node[':doc'] === 'string' ? node[':doc'] : undefined);

/**
 * One level of `node` as a plain value: unwrapped from its metadata, a function as its signature (`ƒ(target)`),
 * a record cut to its own fields. Children stay raw, so each can still be read for its own `:doc`.
 */
export function plainStep(node: unknown): unknown {
  if (!isRecord(node)) return node;
  if (node[':type'] === 'function') {
    const params = Array.isArray(node[':params']) ? node[':params'] : [];
    return `ƒ(${params.join(', ')})`;
  }
  if (':value' in node) return plainStep(node[':value']);
  return Object.fromEntries(fields(node));
}
