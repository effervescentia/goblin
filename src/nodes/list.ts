import type { GoblinEngine } from '../engine';
import type { EvalRoots } from '../utils';
import { Node } from './node';

export class ListNode extends Node<unknown[]> {
  override evaluate(engine: GoblinEngine, scope: EvalRoots): unknown {
    const base = scope.path ?? [];
    return this.raw.map((item, index) => engine.evaluate(item, { ...scope, path: [...base, String(index)] }));
  }
}
