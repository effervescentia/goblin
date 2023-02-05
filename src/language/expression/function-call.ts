import * as P from 'parsimmon';

import { _ } from '../utils';
import { Expression } from './base';

export class FunctionCall extends Expression {
  public static ARG_BEGIN = '(';
  public static ARG_END = ')';
  public static ARG_BIND = ':';
  public static ARG_SEPARATOR = ',';

  public static parse = (
    parseNext: P.Parser<Expression>,
    parseRoot: P.Parser<Expression>,
  ) =>
    parseNext.chain((next) =>
      P.seq(P.regex(/\w+/), _, P.string(this.ARG_BIND), _, parseRoot)
        .map(([key, , , , value]) => [key, value] as const)
        .sepBy(P.seq(_, P.string(this.ARG_SEPARATOR), _))
        .wrap(P.string(this.ARG_BEGIN), P.string(this.ARG_END))
        .map(
          (arguments_) =>
            new FunctionCall(next, Object.fromEntries(arguments_)),
        )
        .or(P.of(next)),
    );

  constructor(
    public readonly function_: Expression,
    public readonly arguments_: Record<string, Expression>,
  ) {
    super();
  }

  toString() {
    return `${FunctionCall.name}(${this.function_}, [${Object.entries(
      this.arguments_,
    )
      .map(([key, value]) => `${key}: ${value.toString()}`)
      .join(', ')}])`;
  }
}
