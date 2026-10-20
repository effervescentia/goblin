/**
 * Where raw trees came from: side tables keyed by the records and lists the
 * engine holds, so provenance survives without touching the documents.
 */
import { ACTOR_KEY, NAMESPACE } from '@/constants';
import { Die } from '@/nodes/die';
import { deepClone } from '@/utils';
import { copyLocations, type Location, type Locations } from './locations';

export class Provenance {
  /** Source document of a raw tree: loaded documents and `$tmpl('…')` clones. */
  readonly origins = new WeakMap<object, string>();
  /** The document a record call's copy was written in: its `#` wherever it lands. */
  readonly homes = new WeakMap<object, unknown>();
  /** The document each `$tmpl` / `$mixin` clone was pulled in by: the
   * template chain a mixin walks up to find its actor. */
  readonly parents = new WeakMap<object, unknown>();
  /** The namespace each `$tmpl('…', 'name')` actor was given. */
  readonly namespaces = new WeakMap<object, string>();
  /** The actor each patch document is being applied to. */
  readonly actorOf = new WeakMap<object, unknown>();
  /** Where each key was written in its source document. */
  readonly locations: Locations = new WeakMap();
  /** Document that wrote each record and list, for `_` field visibility. */
  readonly owners = new WeakMap<object, string>();

  /** The document a raw tree came from, when it is one the engine loaded. */
  sourceOf(raw: unknown): string | undefined {
    return raw && typeof raw === 'object' ? this.origins.get(raw) : undefined;
  }

  /** Where `record[key]` was written in its source document, when known. */
  locationOf(record: object, key: string): Location | undefined {
    return this.locations.get(record)?.get(key);
  }

  /** The namespace a nested actor was given with `$tmpl('…', 'name')`. */
  readonly namespaceOf = (record: object): string | undefined => this.namespaces.get(record);

  /** Mark every record and list in `tree` not yet owned as written by `source`. */
  claim<T>(tree: T, source: string | undefined): T {
    if (source === undefined) return tree;
    const visit = (node: unknown) => {
      if (node === null || typeof node !== 'object' || node instanceof Die) return;
      if (!this.owners.has(node)) this.owners.set(node, source);
      for (const child of Object.values(node)) visit(child);
    };
    visit(tree);
    return tree;
  }

  /** Mark a record call's copy as written in `doc`, so its `#` stays there. */
  settle<T>(tree: T, doc: unknown): T {
    const visit = (node: unknown) => {
      if (node === null || typeof node !== 'object' || node instanceof Die || this.homes.has(node)) return;
      this.homes.set(node, doc);
      for (const child of Object.values(node)) visit(child);
    };
    visit(tree);
    return tree;
  }

  /** A structural copy that keeps the source locations of its keys. */
  clone<T>(value: T): T {
    const copy = deepClone(value);
    copyLocations(value, copy, this.locations);
    this.copyHomes(value, copy);
    return copy;
  }

  /** Homes and actor namespaces follow a copy of the records they mark. */
  private copyHomes(from: unknown, to: unknown): void {
    if (from === null || typeof from !== 'object' || to === null || typeof to !== 'object') return;
    const home = this.homes.get(from);
    if (home !== undefined && !this.homes.has(to)) this.homes.set(to, home);
    const namespace = this.namespaces.get(from);
    if (namespace !== undefined) this.namespaces.set(to, namespace);
    for (const [key, child] of Object.entries(from)) this.copyHomes(child, (to as Record<string, unknown>)[key]);
  }

  /** Give the actor a `$tmpl` call pulls in its namespace; only actors take one. */
  nameActor(clone: unknown, file: string, namespace: string): void {
    if (!NAMESPACE.test(namespace)) throw new Error(`$tmpl('${file}'): invalid actor namespace '${namespace}'`);
    if (
      clone === null ||
      typeof clone !== 'object' ||
      typeof (clone as Record<string, unknown>)[ACTOR_KEY] !== 'string'
    )
      throw new Error(`$tmpl('${file}', '${namespace}'): only an actor document ($actor: X) takes a namespace`);
    this.namespaces.set(clone, namespace);
  }

  /** The namespaces of the actors in `raw`. */
  namespacesIn(raw: unknown): string[] {
    const found: string[] = [];
    const visit = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      const namespace = this.namespaces.get(node);
      if (namespace !== undefined) found.push(namespace);
      Object.values(node).forEach(visit);
    };
    visit(raw);
    return found;
  }

  /** Namespaces name one actor each across the whole tree. */
  assertUniqueNamespaces(raw: unknown): void {
    const seen = new Map<string, { node: object; path: string }>();
    const visit = (node: unknown, path: string[]): void => {
      if (node === null || typeof node !== 'object') return;
      const namespace = this.namespaces.get(node);
      if (namespace !== undefined) {
        const prior = seen.get(namespace);
        if (prior !== undefined && prior.node !== node)
          throw new Error(`duplicate actor namespace ${namespace}: ${prior.path || '<root>'} and ${path.join('.')}`);
        seen.set(namespace, { node, path: path.join('.') });
      }
      for (const [key, child] of Object.entries(node)) visit(child, [...path, key]);
    };
    visit(raw, []);
  }
}
