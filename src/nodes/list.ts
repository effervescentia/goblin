import type { GoblinEngine } from '@/core/engine';
import type { EvalRoots } from '@/utils';
import { Node } from './node';

export class ListNode extends Node<unknown[]> {
  override debug(each: (value: unknown) => unknown): unknown[] {
    return this.raw.map(each);
  }

  override print(each: (value: unknown) => unknown): unknown[] {
    return this.raw.map(each);
  }

  override evaluate(engine: GoblinEngine, scope: EvalRoots): unknown {
    const base = scope.path ?? [];
    // Items are fields too: a rolled item reads the same from every ref.
    return this.raw.map((item, index) =>
      engine.evaluateField(this.raw, String(index), item, { ...scope, path: [...base, String(index)] }),
    );
  }
}
