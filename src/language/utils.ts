import * as P from 'parsimmon';

import { BinaryOperation, Expression, UnaryOperation } from './expression';

export const _ = P.optWhitespace;

export const unary =
  (parseOperator: P.Parser<(expr: Expression) => UnaryOperation>) =>
  (parseNext: P.Parser<Expression>) => {
    const parser: P.Parser<Expression> = P.lazy(() =>
      P.seq(parseOperator, _, parser)
        .map(([factory, , expr]) => factory(expr))
        .or(parseNext),
    );

    return parser;
  };

export const binaryLeft =
  (
    parseOperator: P.Parser<
      (lhs: Expression, rhs: Expression) => BinaryOperation
    >,
  ) =>
  (parseNext: P.Parser<Expression>) => {
    const parser: P.Parser<Expression> = P.lazy(() => {
      const loop = (lhs: Expression): P.Parser<Expression> =>
        P.seq(_, parseOperator, _, parseNext)
          .map(([, factory, , rhs]) => factory(lhs, rhs))
          .chain(loop)
          .or(P.of(lhs));

      return parseNext.chain(loop);
    });

    return parser;
  };

export const binaryRight =
  (
    parseOperator: P.Parser<
      (lhs: Expression, rhs: Expression) => BinaryOperation
    >,
  ) =>
  (parseNext: P.Parser<Expression>) => {
    const parser: P.Parser<Expression> = P.lazy(() =>
      parseNext.chain((lhs) =>
        P.seq(_, parseOperator, _, parser)
          .map(([, factory, , rhs]) => factory(lhs, rhs))
          .or(P.of(lhs)),
      ),
    );

    return parser;
  };
