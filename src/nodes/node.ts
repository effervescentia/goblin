import type { GoblinEngine } from '../engine';
import type { EvalRoots } from '../utils';

/**
 * A classified document value. Each subclass implements one branch of
 * evaluation; dispatch lives in `./parse`. Nodes call back into
 * `engine.evaluate` / `engine.evalExpr` (public API) for children, so there
 * are no runtime import cycles (the engine import is type-only).
 */
export abstract class Node<T = unknown> {
  constructor(protected readonly raw: T) {}

  abstract evaluate(engine: GoblinEngine, scope: EvalRoots): unknown;

  debug(_each: (value: unknown) => unknown): unknown {
    return this.raw;
  }

  print(each: (value: unknown) => unknown): unknown {
    return this.debug(each);
  }
}
