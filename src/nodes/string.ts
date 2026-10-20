import { Node } from './node';

/** A plain string: no sigils, no dice — passes through untouched. */
export class StringNode extends Node<string> {
  override evaluate(): unknown {
    return this.raw;
  }
}
