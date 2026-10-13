import type { GoblinEngine } from '../engine';
import type { EvalRoots } from '../utils';
import { Node } from './node';

/** A string containing sigil refs: evaluated on demand. */
export class ExpressionNode extends Node<string> {
  override evaluate(engine: GoblinEngine, scope: EvalRoots): unknown {
    return engine.evalExpr(this.raw, scope);
  }
}
