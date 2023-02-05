/* eslint-disable @typescript-eslint/ban-types */
import * as P from 'parsimmon';

import { BooleanType, NumberType, StringType } from '../../models/type';
import { Expression } from './base';

export class BooleanLiteral extends Expression {
  public static TRUE = 'true';
  public static FALSE = 'false';

  public static parse = P.alt(P.string(this.TRUE), P.string(this.FALSE)).map(
    (s) => new BooleanLiteral(s === this.TRUE),
  );

  private constructor(public readonly value: boolean) {
    super();
  }

  typeof() {
    return new BooleanType();
  }

  toString() {
    return `${BooleanLiteral.name}(${this.value})`;
  }
}

export class NumberLiteral extends Expression {
  public static parse = P.regex(/\d+(\.\d+)?/).map(
    (s) => new NumberLiteral(Number(s)),
  );

  private constructor(public readonly value: number) {
    super();
  }

  typeof() {
    return new NumberType();
  }

  toString() {
    return `${NumberLiteral.name}(${this.value})`;
  }
}

export class StringLiteral extends Expression {
  public static QUOTE = "'";
  public static PATTERN = new RegExp(
    `${this.QUOTE}((?:\\${this.QUOTE}|[^${this.QUOTE}])*)${this.QUOTE}`,
  );
  public static ESCAPED_QUOTES = new RegExp(`\\\\${this.QUOTE}`, 'g');

  public static parse = P.regex(this.PATTERN, 1).map(
    (s) => new StringLiteral(s.replace(this.ESCAPED_QUOTES, this.QUOTE)),
  );

  private constructor(public readonly value: string) {
    super();
  }

  typeof() {
    return new StringType();
  }

  toString() {
    return `${StringLiteral.name}(${this.value})`;
  }
}
