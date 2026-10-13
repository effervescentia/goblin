import type { GoblinEngine } from '../engine';
import type { EvalRoots } from '../utils';
import { Node } from './node';

export class ListNode extends Node<unknown[]> {
  /** Printed form: item-wise, through the caller's `each` for recursion. */
  static serialize(items: unknown[], each: (value: unknown) => unknown): unknown[] {
    return items.map(each);
  }

  override evaluate(engine: GoblinEngine, scope: EvalRoots): unknown {
    const base = scope.path ?? [];
    return this.raw.map((item, index) => engine.evaluate(item, { ...scope, path: [...base, String(index)] }));
  }
}
