import { Node } from './node';

export class NullNode extends Node<null | undefined> {
  override evaluate(): unknown {
    return this.raw;
  }
}
