import * as P from 'parsimmon';

import { Expression } from './base';

export class DiceRoll extends Expression {
  public static SEPARATOR = 'd';

  public static parse = P.seq(
    P.regex(/\d\d+|[1-9]/).map(Number),
    P.string(this.SEPARATOR),
    P.regex(/\d\d+|[2-9]/).map(Number),
  ).map(([count, , max]) => new DiceRoll(count, max));

  constructor(public readonly count: number, public readonly max: number) {
    super();
  }

  toString() {
    return `${DiceRoll.name}(${this.count}, ${this.max})`;
  }
}
