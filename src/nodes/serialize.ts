import { FunctionNode } from './function';
import { parse } from './parse';

/** JSON-friendly rendering of an evaluated value. Dispatch mirrors `./parse`:
 * each kind owns its printed form, containers recurse back through here. */
export function debug(value: unknown): unknown {
  if (typeof value === 'function') return FunctionNode.debug(value);
  return parse(value).debug(debug);
}

/** Plain rendering, with each node dropping its own metadata. */
export function print(value: unknown): unknown {
  if (typeof value === 'function') return FunctionNode.print(value);
  return parse(value).print(print);
}
