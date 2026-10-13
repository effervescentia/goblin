import { Node } from './node';

export class NumberNode extends Node<number> {
  override evaluate(): unknown {
    return this.raw;
  }
}
