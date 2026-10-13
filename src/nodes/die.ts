import type { Die } from '../utils';
import { Node } from './node';

/** A standalone `dN` / `NdM` spec: returned, never rolled. */
export class DieNode extends Node<Die> {
  override evaluate(): unknown {
    return this.raw;
  }
}
