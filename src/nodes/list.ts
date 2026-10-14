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
    // Items are fields too: a rolled item reads the same from every ref.
    return this.raw.map((item, index) =>
      engine.evaluateField(this.raw, String(index), item, { ...scope, path: [...base, String(index)] }),
    );
  }
}
