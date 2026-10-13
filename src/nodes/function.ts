import { FUNCTION_KEY } from '../constants';
import type { GoblinEngine } from '../engine';
import type { EvalRoots } from '../utils';
import { detectDeps, isFunctionKey, tagFunction } from '../utils';
import { Node } from './node';

/**
 * A `name()` / `name(params)` key with a string body. Evaluates to a tagged
 * callable; `.` inside the body is the record holding the definition.
 */
export class FunctionNode extends Node<string> {
  readonly name: string;
  readonly params: string[];

  constructor(
    key: string,
    readonly body: string,
    readonly record: Record<string, unknown>,
  ) {
    super(body);
    const match = key.match(FUNCTION_KEY)!;
    this.name = match[1]!;
    this.params = match[2]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  static match(key: string, value: unknown, record: Record<string, unknown>): FunctionNode | null {
    if (typeof value !== 'string' || !isFunctionKey(key)) return null;
    return new FunctionNode(key, value, record);
  }

  override evaluate(engine: GoblinEngine, scope: EvalRoots): unknown {
    const fnPath = [...(scope.path ?? []), this.name];
    const fn = (...args: unknown[]) => {
      const callParams = Object.fromEntries(this.params.map((p, i) => [p, args[i]]));
      return engine.evalExpr(this.body, { ...scope, current: this.record, params: callParams, path: fnPath });
    };
    return tagFunction(fn, { name: this.name, params: this.params, source: this.body, deps: detectDeps(this.body) });
  }
}
