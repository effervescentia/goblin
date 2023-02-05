import { Expression } from './base';

export class DotAccess extends Expression {
  constructor(
    public readonly object: Expression,
    public readonly property: string,
  ) {
    super();
  }

  toString() {
    return `${DotAccess.name}(${this.object}, ${this.property})`;
  }
}
