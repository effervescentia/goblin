import { SIGIL_REF } from '../constants';
import type { GoblinEngine } from '../engine';
import type { EvalRoots } from '../utils';
import { DieNode } from './die';
import { Node } from './node';

/** A string containing sigil refs: evaluated on demand. */
export class ExpressionNode extends Node<string> {
  /** A string the engine must evaluate: a die literal or any sigil ref. */
  static matches(s: string): boolean {
    if (DieNode.isLiteral(s)) return true;
    SIGIL_REF.lastIndex = 0;
    return SIGIL_REF.test(s);
  }

  override evaluate(engine: GoblinEngine, scope: EvalRoots): unknown {
    return engine.evalExpr(this.raw, scope);
  }
}
