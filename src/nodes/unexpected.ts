import { Node } from './node';

export class UnexpectedNode extends Node<unknown> {
  override evaluate(): unknown {
    return this.raw;
  }
}
