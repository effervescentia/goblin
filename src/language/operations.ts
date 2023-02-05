import * as P from 'parsimmon';

import {
  Add,
  And,
  Divide,
  Equal,
  Exponent,
  Expression,
  FunctionCall,
  GreaterOrEqual,
  GreaterThan,
  LessOrEqual,
  LessThan,
  Multiply,
  Negative,
  Not,
  NotEqual,
  Or,
  Subtract,
} from './expression';
import { _, binaryLeft, binaryRight, unary } from './utils';

export const OPERATIONS: Array<
  (
    parseNext: P.Parser<Expression>,
    parseRoot: P.Parser<Expression>,
  ) => P.Parser<Expression>
> = [
  FunctionCall.parse,
  unary(P.alt(Not.parse, Negative.parse)),
  binaryRight(Exponent.parse),
  binaryLeft(P.alt(Multiply.parse, Divide.parse)),
  binaryLeft(P.alt(Add.parse, Subtract.parse)),
  binaryLeft(
    P.alt(
      LessOrEqual.parse,
      LessThan.parse,
      GreaterOrEqual.parse,
      GreaterThan.parse,
    ),
  ),
  binaryLeft(P.alt(Equal.parse, NotEqual.parse)),
  binaryLeft(P.alt(And.parse, Or.parse)),
];
