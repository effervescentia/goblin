/** Goblin inputs — the append-only `--param` / `--set` / `--invoke` / `--import` stream a
 * resolution replays. A later parameter or override for the same path wins; invokes
 * all run, in order. */

/** A write the engine made while resolving — a patch value or `=` (`set`),
 * `+` (`add`), `-=` (`subtract`) — at `path` from the entry root. Replay makes
 * it again from the inputs, reusing the recorded value when an invoke made it
 * (rolls replay on their own, as roll events). */
export interface WriteEvent {
  version: number;
  type: 'set' | 'add' | 'subtract';
  path: string;
  value: unknown;
  /** The value came from dice (rolled by the write itself, not read from a rolled field). */
  rolled?: boolean;
  /** The labelled expression an assignment wrote, with its parts (see `Calculation`). */
  formula?: string;
  parts?: Part[];
  source?: string;
  line?: number;
  column?: number;
}

export function isWriteEvent(event: StateEvent): event is WriteEvent {
  return event.type === 'set' || event.type === 'add' || event.type === 'subtract';
}

/** One roll of `dice` (`XdY`) while resolving, its faces in `value`, in the
 * context it rolled in: the field whose evaluation rolled it (`path` from the
 * entry root), or the invoke whose call did (its `version` and `path`).
 * Replay hands the faces back. */
export interface RollEvent {
  version: number;
  type: 'roll';
  path: string;
  dice: string;
  value: number[];
  /** The labelled expression that rolled it, with its parts (see `Calculation`). */
  formula?: string;
  parts?: Part[];
}

/** One `[Label](expr)` tag an expression evaluated, and what it came to. */
export interface Part {
  label: string;
  value: unknown;
}

/** `XdY` → `[X, Y]`, or undefined when it is not one. */
export function parseDice(dice: string): [number, number] | undefined {
  const match = dice.match(/^([1-9]\d*)d([1-9]\d*)$/);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/** The state JSON's `events`: inputs, with the writes and rolls they led to woven in. */
export type StateEvent = InputEvent | WriteEvent | RollEvent;

export function isRollEvent(event: StateEvent): event is RollEvent {
  return event.type === 'roll';
}

export function isInputEvent(event: StateEvent): event is InputEvent {
  return event.type === 'parameter' || event.type === 'override' || event.type === 'invoke' || event.type === 'import';
}

/** One `--param`, `--set`, `--invoke` (`value` holds its arguments) or
 * `--import` (`value` holds an `ImportValue`), given on the run that produced `version`. */
export interface InputEvent {
  version: number;
  type: 'parameter' | 'override' | 'invoke' | 'import';
  path: string;
  value: unknown;
}

/** An exported actor's state: one `set` per node, its path relative to the actor. */
export interface ActorSet {
  type: 'set';
  path: string;
  value: unknown;
}

/** What an `import` event carries: the application hash it was exported from, and its sets. */
export interface ImportValue {
  application: string;
  events: ActorSet[];
}

/** What `--export` prints: an actor's sets, the application they came from, and a sha256 over the rest. */
export interface ActorExport extends ImportValue {
  hash: string;
  actor: string;
}

/** Overrides an import unpacked to: one meeting a `:param` node leaves it to the parameter beside it. */
const unpacked = new WeakSet<InputEvent>();

export const isUnpacked = (event: InputEvent): boolean => unpacked.has(event);

/** Unpack each `import` in place into a parameter and an override per set, under
 * its path: the parameter fills a `:param` node there (mixins choose by it, and a
 * later parameter still changes it), the override freezes any other node. Both
 * keep the import's version. */
export function unpackImports(events: readonly InputEvent[]): InputEvent[] {
  return events.flatMap((event) => {
    if (event.type !== 'import') return [event];
    const { events: sets } = event.value as ImportValue;
    return sets.flatMap(({ path, value }) => {
      const at = `${event.path}.${path}`;
      const frozen = override(at, value, event.version);
      unpacked.add(frozen);
      return [parameter(at, value, event.version), frozen];
    });
  });
}

export function parameter(path: string, value: unknown, version = 1): InputEvent {
  return { version, type: 'parameter', path, value };
}

export function override(path: string, value: unknown, version = 1): InputEvent {
  return { version, type: 'override', path, value };
}

export function invoke(path: string, args: unknown[] = [], version = 1): InputEvent {
  return { version, type: 'invoke', path, value: args };
}

/** The latest event of `type` for each path, ordered by when it arrived. */
export function latest(events: readonly InputEvent[], type: InputEvent['type']): InputEvent[] {
  const byPath = new Map<string, InputEvent>();
  for (const event of events) {
    if (event.type !== type) continue;
    byPath.delete(event.path);
    byPath.set(event.path, event);
  }
  return [...byPath.values()];
}

/** The value of the latest parameter event for the first of `paths` given one. */
export function paramValue(events: readonly InputEvent[] = [], ...paths: string[]): unknown {
  for (const path of paths) {
    const event = events.findLast((e) => e.type === 'parameter' && e.path === path);
    if (event !== undefined) return event.value;
  }
  return undefined;
}

/** Events addressed under `path`, re-pathed relative to it. */
export function nest(events: readonly InputEvent[] | undefined, path: string[]): InputEvent[] {
  if (events === undefined) return [];
  if (path.length === 0) return [...events];
  const prefix = `${path.join('.')}.`;
  return events
    .filter((event) => event.path.startsWith(prefix))
    .map((event) => {
      const moved = { ...event, path: event.path.slice(prefix.length) };
      if (unpacked.has(event)) unpacked.add(moved);
      return moved;
    });
}
