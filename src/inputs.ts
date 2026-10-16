/** Goblin inputs — the append-only `--param` / `--set` stream a resolution
 * replays. A later event for the same path wins. */

/** One `--param` or `--set`, given on the run that produced `version`. */
export interface InputEvent {
  version: number;
  type: 'param' | 'set';
  path: string;
  value: unknown;
}

export function param(path: string, value: unknown, version = 1): InputEvent {
  return { version, type: 'param', path, value };
}

export function set(path: string, value: unknown, version = 1): InputEvent {
  return { version, type: 'set', path, value };
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

/** The value of the latest param event for the first of `paths` given one. */
export function paramValue(events: readonly InputEvent[] = [], ...paths: string[]): unknown {
  for (const path of paths) {
    const event = events.findLast((e) => e.type === 'param' && e.path === path);
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
