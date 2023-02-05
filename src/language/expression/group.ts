import * as P from 'parsimmon';

import { Expression } from './base';

export class Group extends Expression {
  public static BEGIN = '(';
  public static END = ')';

  public static parse = (
    parseNext: P.Parser<Expression>,
    parseRoot: P.Parser<Expression>,
  ) =>
    parseRoot
      .wrap(P.string(this.BEGIN), P.string(this.END))
      .map((expression) => new Group(expression))
      .or(parseNext);

  constructor(public readonly expression: Expression) {
    super();
  }

  toString() {
    return `${Group.name}(${this.expression.toString()})`;
  }
}
