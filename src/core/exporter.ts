/**
 * Exporting one actor: everything the goblin files cannot make again on their
 * own — params, overrides, imports, invoke writes and rolls — collapsed to one
 * `set` per node, holding its current value, for an `import` elsewhere.
 */
import { ACTOR_KEY } from '@/constants';
import { type ActorSet, type ImportValue, isInputEvent, type StateEvent } from '@/inputs';
import { print } from '@/nodes/serialize';
import { getPath } from '@/utils';
import type { GoblinEngine } from './engine';

/** Where an actor sits in the entry: its tree path, and the namespace it was given, if any. */
interface ActorAt {
  path: string[];
  namespace?: string;
}

/** The actor `id` names in the resolved raw `root`: by namespace (`aria`), else by tree path (`party.scout`). */
export function locateActor(engine: GoblinEngine, root: unknown, id: string): ActorAt | undefined {
  const seen = new Set<object>();
  const find = (node: unknown, path: string[]): string[] | undefined => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return undefined;
    seen.add(node);
    if (!Array.isArray(node) && engine.namespaceOf(node) === id) return path;
    for (const [key, child] of Object.entries(node)) {
      const found = find(child, [...path, key]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const named = find(root, []);
  if (named !== undefined) return { path: named, namespace: id };
  const path = id.split('.');
  const node = getPath(root, path);
  if (node === null || typeof node !== 'object' || typeof (node as Record<string, unknown>)[ACTOR_KEY] !== 'string')
    return undefined;
  return { path, namespace: engine.namespaceOf(node) };
}

/** `path` (by namespace, tree path or `@.`/`#.`/`.` from the root) relative to the actor, when it is under it. */
function relativeTo(at: ActorAt, path: string): string | undefined {
  const bare = path.replace(/^[@#]?\./, '');
  for (const prefix of [at.namespace, at.path.join('.')]) {
    if (prefix !== undefined && bare.startsWith(`${prefix}.`)) return bare.slice(prefix.length + 1);
  }
  return undefined;
}

/**
 * The actor at `at`'s state after `events` resolved `root` to `data`: one `set`
 * per node holding state, in path order. A node under another one kept is
 * dropped, since its value is part of that one's.
 */
export function exportActor(
  engine: GoblinEngine,
  root: unknown,
  data: unknown,
  events: StateEvent[],
  at: ActorAt,
): ActorSet[] {
  const paths = new Set<string>();
  const add = (path: string) => {
    const relative = relativeTo(at, path);
    if (relative !== undefined) paths.add(relative);
  };
  for (const event of events.filter(isInputEvent)) {
    if (event.type === 'parameter' || event.type === 'override') add(event.path);
    if (event.type === 'import')
      for (const set of (event.value as ImportValue).events) add(`${event.path}.${set.path}`);
  }
  // Writes a mixin made come back from the files; an invoke's and dice do not.
  for (const { cause, event } of engine.events(root, data)) {
    const kept = event.type === 'roll' ? cause === undefined : cause !== undefined || event.rolled === true;
    if (kept) add(event.path);
  }
  const sorted = [...paths].sort();
  const actor = getPath(print(data), at.path);
  return sorted
    .filter((path) => !sorted.some((outer) => path.startsWith(`${outer}.`)))
    .flatMap((path) => {
      const value = getPath(actor, path.split('.'));
      return value === undefined ? [] : [{ type: 'set' as const, path, value }];
    });
}
