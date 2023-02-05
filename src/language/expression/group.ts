import * as P from 'parsimmon';

import { Expression } from './base';

export class Group extends Expression {
  public static parse = (
    parseNext: P.Parser<Expression>,
    parseRoot: P.Parser<Expression>,
  ) =>
    parseRoot
      .wrap(P.string('('), P.string(')'))
      .map((expression) => new Group(expression))
      .or(parseNext);

  constructor(public readonly expression: Expression) {
    super();
  }

  toString() {
    return `${Group.name}(${this.expression.toString()})`;
  }
}
