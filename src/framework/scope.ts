import type { NodeContext } from './context';
import type { Node } from './node';

export class Scope {
  constructor(
    public readonly node: Node,
    public readonly context: NodeContext,
    public readonly parameters: Record<string, unknown> = {},
  ) {}
}
