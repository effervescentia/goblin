/** Goblin inputs — the append-only `--param` / `--set` / `--invoke` stream a
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
  source?: string;
  line?: number;
  column?: number;
}

export function isWriteEvent(event: StateEvent): event is WriteEvent {
  return event.type === 'set' || event.type === 'add' || event.type === 'subtract';
}

/** One die face rolled while resolving, in the context it rolled in: the
 * field whose evaluation rolled it (`path` from the entry root), or the
 * invoke whose call did (its `version` and `path`). Replay hands it back. */
export interface RollEvent {
  version: number;
  type: 'roll';
  path: string;
  sides: number;
  value: number;
}

/** The state JSON's `events`: inputs, with the writes and rolls they led to woven in. */
export type StateEvent = InputEvent | WriteEvent | RollEvent;

export function isRollEvent(event: StateEvent): event is RollEvent {
  return event.type === 'roll';
}

export function isInputEvent(event: StateEvent): event is InputEvent {
  return event.type === 'parameter' || event.type === 'override' || event.type === 'invoke';
}

/** One `--param`, `--set` or `--invoke` (`value` holds its arguments), given
 * on the run that produced `version`. */
export interface InputEvent {
  version: number;
  type: 'parameter' | 'override' | 'invoke';
  path: string;
  value: unknown;
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
    .map((event) => ({ ...event, path: event.path.slice(prefix.length) }));
}
