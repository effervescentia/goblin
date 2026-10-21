/**
 * Reading a resolved character out of the engine's `data`, metadata and all:
 * params and evented fields carry their value under `:value`, labels under `:label`.
 */

import { isRollEvent, isWriteEvent, type RollEvent, type StateEvent } from '@/inputs';
import type { InspectNode } from '@/inspect';
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

/** A run of a formula: text as written, a label with its part's value, or an unlabelled ref (`.start`) with the
 * value it reads. `hue` numbers the labels in order of appearance (the same label, the same hue), so a label and
 * its value can be marked alike. */
export type Segment =
  | { text: string }
  | { label: string; value: unknown; hue: number }
  | { ref: string; value: unknown };

/** A labelled field's `:formula`, and it in segments, to show it solved (`10 + DEX` → `10 + 2`). */
export interface Formula {
  formula: string;
  segments: Segment[];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `formula` split at each label, paired with its part's value. Parts come in the order their tags finished
 * (inner before outer), so each label takes the next part of its name; one a conditional skipped stays text. */
export function solve(formula: string, parts: { label: string; value: unknown }[]): Segment[] {
  const labels = [...new Set(parts.map(({ label }) => label))].sort((a, b) => b.length - a.length);
  if (labels.length === 0) return [{ text: formula }];
  const segments: Segment[] = [];
  const hues = new Map<string, number>();
  const text = (run: string) => {
    const last = segments.at(-1);
    if (last && 'text' in last) last.text += run;
    else if (run) segments.push({ text: run });
  };
  let next = 0;
  let from = 0;
  for (const match of formula.matchAll(new RegExp(`(?<!\\w)(?:${labels.map(escapeRegExp).join('|')})(?!\\w)`, 'g'))) {
    const label = match[0];
    text(formula.slice(from, match.index));
    from = match.index + label.length;
    const at = parts.findIndex((part, i) => i >= next && part.label === label);
    if (at === -1) {
      text(label);
      continue;
    }
    next = at + 1;
    if (!hues.has(label)) hues.set(label, hues.size);
    segments.push({ label, value: parts[at]?.value, hue: hues.get(label) ?? 0 });
  }
  text(formula.slice(from));
  return segments;
}

/** `.start` (beside the field) or `@.abilities.dexterity.modifier` (on the character); not `#.x`, `$lib.x` or `a.b`. */
const REF = /(?<![\w.#)\]])@?\.[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g;

/** `segments` with each unlabelled ref in their text read through `read`; one it can't read stays text. */
export function solveRefs(segments: Segment[], read: (ref: string) => unknown): Segment[] {
  return segments.flatMap((segment) => {
    if (!('text' in segment)) return [segment];
    const runs: Segment[] = [];
    let from = 0;
    for (const match of segment.text.matchAll(REF)) {
      const value = read(match[0]);
      if (value === undefined) continue;
      if (match.index > from) runs.push({ text: segment.text.slice(from, match.index) });
      runs.push({ ref: match[0], value });
      from = match.index + match[0].length;
    }
    if (from < segment.text.length) runs.push({ text: segment.text.slice(from) });
    return runs;
  });
}

/** Segments as text, each label or ref read as its value; undefined when none has one (nothing was solved). */
export function solvedText(segments: Segment[]): string | undefined {
  if (segments.every((segment) => 'text' in segment)) return undefined;
  return segments.map((segment) => ('text' in segment ? segment.text : String(segment.value))).join('');
}

export function formulaAt(node: unknown, path: string): Formula | undefined {
  const keys = path.split('.');
  const parent = keys.length > 1 ? at(node, keys.slice(0, -1).join('.')) : node;
  const field = isRecord(parent) ? parent[keys.at(-1) ?? ''] : undefined;
  if (!isRecord(field) || typeof field[':formula'] !== 'string') return undefined;
  const parts = (Array.isArray(field[':parts']) ? field[':parts'] : [])
    .filter(isRecord)
    .map((part) => ({ label: String(part[':label']), value: part[':value'] }));
  const read = (ref: string) => (ref.startsWith('@') ? at(node, ref.slice(2)) : at(parent, ref.slice(1)));
  return { formula: field[':formula'], segments: solveRefs(solve(field[':formula'], parts), read) };
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
  /** How the initiative was rolled (`1d20 + .base` → `14 + 3`), once its roll is in `events`. */
  formula?: Formula;
  events: FieldEvent[];
}

export interface Combat {
  round: unknown;
  current: unknown;
  order: Combatant[];
}

/** The fight in progress at `data.combat`, in turn order; null between fights. `events` (the envelope's) give each
 * combatant its initiative roll: those since the fight began, one per member in `members` order. */
export function combatOf(data: unknown, events: StateEvent[] = []): Combat | null {
  const combat = at(data, 'combat');
  if (!isRecord(combat)) return null;
  const order = at(combat, 'order');
  const members = at(combat, 'members');
  const start = events.findLastIndex((event) => isWriteEvent(event) && event.path === 'combat');
  const rolls = events
    .slice(start + 1)
    .filter((event): event is RollEvent => isRollEvent(event) && event.path === 'combat.initiative');
  return {
    round: at(combat, 'round'),
    current: at(combat, 'current'),
    order: (Array.isArray(order) ? order : []).map((key) => {
      const roll = Array.isArray(members) ? rolls[members.indexOf(key)] : undefined;
      return {
        key: String(key),
        initiative: at(combat, `initiative.${key}`),
        ...(roll ? rollFormula(roll) : { events: [] }),
      };
    }),
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

/** `roll` as the labelled expression that made it recorded it: its formula, with the dice (unless a tag holds
 * them) standing for their total. */
function rollFormula(roll: RollEvent): Pick<Combatant, 'formula' | 'events'> {
  const events = [{ ':roll': roll.dice, ':faces': roll.value, ':version': roll.version }];
  if (roll.formula === undefined) return { events };
  const { formula, parts = [] } = roll;
  const total = roll.value.reduce((sum, face) => sum + face, 0);
  // `solve` takes parts in the order their labels appear.
  const ordered = [...parts, { label: roll.dice, value: total }].sort(
    (a, b) => formula.indexOf(a.label) - formula.indexOf(b.label),
  );
  return { formula: { formula, segments: solve(formula, ordered) }, events };
}

/** One entry of a field's `:events`: a `:set`, `:add` or `:subtract` and where it came from. */
export type FieldEvent = Record<string, unknown>;

/** A value that only holds a slot open: an empty list, or a record of metadata alone (`{ :doc }`). */
const isPlaceholder = (value: unknown) =>
  value === undefined ||
  value === null ||
  (Array.isArray(value) && value.length === 0) ||
  (isRecord(value) && Object.keys(value).every((key) => key.startsWith(':')));

/** The `:events` of the field at `path` under `node`, minus a first event that only declared an empty slot. */
export function eventsAt(node: unknown, path: string): FieldEvent[] {
  const keys = path.split('.');
  const parent = keys.length > 1 ? at(node, keys.slice(0, -1).join('.')) : node;
  const field = isRecord(parent) ? parent[keys.at(-1) as string] : undefined;
  const events = isRecord(field) && Array.isArray(field[':events']) ? (field[':events'] as FieldEvent[]) : [];
  return events.filter((event, i) => i > 0 || !(':set' in event && isPlaceholder(event[':set'])));
}

const show = (value: unknown) =>
  Array.isArray(value) ? value.map((item) => humanize(String(item))).join(', ') : String(value);

/** What `event` did: `set to 12`, `+1`, `−1`, `added` for a key a record addition introduced, or `rolled 1d20: 14`. */
export function describeEvent(event: FieldEvent): string {
  if (':roll' in event) return `rolled ${show(event[':roll'])}: ${show(event[':faces'])}`;
  if (':subtract' in event) return `−${show(event[':subtract'])}`;
  if (':add' in event) {
    const added = event[':add'];
    if (typeof added === 'number') return `+${added}`;
    return Array.isArray(added) ? `added ${show(added)}` : 'added';
  }
  return `set to ${show(event[':set'])}`;
}

/** Where `event` came from: `class/fighter/fighter.yaml:7`, or the run an override was given in. */
export function sourceOf(event: FieldEvent): string {
  const source = typeof event[':source'] === 'string' ? event[':source'] : undefined;
  if (typeof event[':version'] === 'number')
    return source ? `${source} (turn ${event[':version']})` : `turn ${event[':version']}`;
  if (source === undefined) return 'unknown';
  return typeof event[':line'] === 'number' ? `${source}:${event[':line']}` : source;
}

/** The expression behind each derived field under `prefix`, by path relative to it; a literal that only
 * restates its value (`d10`) is left out. */
export function expressionsOf(nodes: InspectNode[], prefix: string): Map<string, string> {
  const derived = new Map<string, string>();
  for (const { kind, path, expression, value } of nodes) {
    if (kind !== 'expression' || expression === undefined || expression === String(value)) continue;
    if (path.startsWith(`${prefix}.`)) derived.set(path.slice(prefix.length + 1), expression);
  }
  return derived;
}
