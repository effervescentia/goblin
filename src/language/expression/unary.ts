/* eslint-disable @typescript-eslint/ban-types */
import * as P from 'parsimmon';

import { Expression } from './base';

export abstract class UnaryOperation extends Expression {
  public static createParser = (Parser: {
    OPERATOR: string;
    new (...args: ConstructorParameters<typeof UnaryOperation>): UnaryOperation;
  }) =>
    P.string(Parser.OPERATOR).map(() => (expr: Expression) => new Parser(expr));

  constructor(public readonly expression: Expression) {
    super();
  }

  stringify(func: Function) {
    return `${func.name}(${this.expression})`;
  }
}

export class Not extends UnaryOperation {
  public static OPERATOR = '!';

  public static parse = this.createParser(this);

  toString() {
    return this.stringify(Not);
  }
}
export class Negative extends UnaryOperation {
  public static OPERATOR = '-';

  public static parse = this.createParser(this);

  toString() {
    return this.stringify(Negative);
  }
}
