import * as P from 'parsimmon';

import {
  Argument,
  BooleanLiteral,
  DataReference,
  Expression,
  FileReference,
  NumberLiteral,
  StringLiteral,
} from '../models/expression';
import { OPERATIONS } from './operations';
import { _ } from './utils';

class InvalidExpression extends Error {}

export interface Language {
  Term: Expression;
  Literal: Expression;
  Identifier: Expression;
  Expression: Expression;
}

export const Language = Object.assign(
  P.createLanguage<Language>({
    Term: (r) => P.alt(r.Literal, r.Identifier),

    Literal: () =>
      P.alt(BooleanLiteral.parse, NumberLiteral.parse, StringLiteral.parse),

    Identifier: () =>
      P.alt(Argument.parse, DataReference.parse, FileReference.parse),

    Expression: (r) =>
      OPERATIONS.reduce((acc, operation) => operation(acc), r.Term),
  }),
  {
    parse: (data: string): Expression => {
      const result = Language.Expression.parse(data);
      if (!result.status) throw new InvalidExpression(data);

      return result.value;
    },
  },
);
