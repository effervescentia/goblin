import { Node } from './node';

export class BooleanNode extends Node<boolean> {
  override evaluate(): unknown {
    return this.raw;
  }
}
