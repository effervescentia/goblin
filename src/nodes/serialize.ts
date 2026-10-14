import { Die, DieNode } from './die';
import { FunctionNode } from './function';
import { ListNode } from './list';
import { RecordNode } from './record';

/** JSON-friendly rendering of an evaluated value. Dispatch mirrors `./parse`:
 * each kind owns its printed form, containers recurse back through here. */
export function serialize(value: unknown): unknown {
  if (value instanceof Die) return DieNode.serialize(value);
  if (typeof value === 'function') return FunctionNode.serialize(value);
  if (Array.isArray(value)) return ListNode.serialize(value, serialize);
  if (value && typeof value === 'object') return RecordNode.serialize(value as Record<string, unknown>, serialize);
  return value;
}
