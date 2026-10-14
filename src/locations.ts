/**
 * Where each key of a document was written: `line`/`column` (1-based) of the
 * key in its `.yaml` source, keyed by the parsed record or list holding it.
 * Events cite these so a client can link a change back to the line behind it.
 */
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node as YamlNode } from 'yaml';

export interface Location {
  line: number;
  column: number;
}

export type Locations = WeakMap<object, Map<string, Location>>;

/**
 * Record the position of every key in `text` against `data`, the same text
 * already parsed (by any parser): the two trees are walked in step.
 */
export function collectLocations(text: string, data: unknown, into: Locations): void {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });
  const at = (offset: number | undefined): Location | undefined => {
    if (offset === undefined) return undefined;
    const { line, col } = lines.linePos(offset);
    return { line, column: col };
  };
  const visit = (node: YamlNode | null | undefined, value: unknown) => {
    if (value === null || typeof value !== 'object') return;
    const keys = new Map<string, Location>();
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
        const loc = at((pair.key as YamlNode | null)?.range?.[0]);
        if (loc) keys.set(key, loc);
        visit(pair.value as YamlNode | null, (value as Record<string, unknown>)[key]);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, index) => {
        const loc = at((item as YamlNode | null)?.range?.[0]);
        if (loc) keys.set(String(index), loc);
        visit(item as YamlNode | null, (value as unknown[])[index]);
      });
    }
    if (keys.size > 0) into.set(value, keys);
  };
  visit(doc.contents, data);
}

/** Copy `from`'s locations onto `to`, a structural clone of it. */
export function copyLocations(from: unknown, to: unknown, locations: Locations): void {
  if (from === null || typeof from !== 'object' || to === null || typeof to !== 'object') return;
  const keys = locations.get(from);
  if (keys && !locations.has(to)) locations.set(to, keys);
  for (const [key, child] of Object.entries(from))
    copyLocations(child, (to as Record<string, unknown>)[key], locations);
}
