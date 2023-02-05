/* eslint-disable @typescript-eslint/ban-types */
import * as P from 'parsimmon';

import { BooleanType, NumberType } from '../../models/type';
import { Expression } from './base';

export abstract class BinaryOperation extends Expression {
  public static createParser = (Parser: {
    OPERATOR: string;
    new (
      ...args: ConstructorParameters<typeof BinaryOperation>
    ): BinaryOperation;
  }) =>
    P.string(Parser.OPERATOR).map(
      () => (lhs: Expression, rhs: Expression) => new Parser(lhs, rhs),
    );

  constructor(
    public readonly lhs: Expression,
    public readonly rhs: Expression,
  ) {
    super();
  }

  stringify(func: Function) {
    return `${func.name}(${this.lhs}, ${this.rhs})`;
  }
}

export abstract class Arithmetic extends BinaryOperation {
  typeof() {
    return new NumberType();
  }
}
export class Add extends Arithmetic {
  public static OPERATOR = '+';

  public static parse = this.createParser(this);

  toString() {
    return this.stringify(Add);
  }
}
export class Subtract extends Arithmetic {
  public static OPERATOR = '-';

  public static parse = this.createParser(this);

  toString() {
    return this.stringify(Subtract);
  }
}
export class Multiply extends Arithmetic {
  public static OPERATOR = '*';

  public static parse = this.createParser(this);

  toString() {
    return this.stringify(Multiply);
  }
}
export class Divide extends Arithmetic {
  public static OPERATOR = '/';

  public static parse = this.createParser(this);

  toString() {
    return this.stringify(Divide);
  }
}
export class Exponent extends Arithmetic {
  public static OPERATOR = '^';

  public static parse = this.createParser(this);

  toString() {
    return this.stringify(Exponent);
  }
}

export abstract class Comparison extends BinaryOperation {
  typeof() {
    return new BooleanType();
  }
}
export class LessThan extends Comparison {
  public static OPERATOR = '<';

  public static parse = this.createParser(this);

  toString() {
    return this.stringify(LessThan);
  }
}
export class LessOrEqual extends Comparison {
  public static OPERATOR = '<=';

  public static parse = this.createParser(this);

  toString() {
    return this.stringify(LessOrEqual);
  }
}
export class GreaterThan extends Comparison {
  public static OPERATOR = '>';

  public static parse = this.createParser(this);

  toString() {
    return this.stringify(GreaterThan);
  }
}
export class GreaterOrEqual extends Comparison {
  public static OPERATOR = '>=';

  public static parse = this.createParser(this);

  toString() {
    return this.stringify(GreaterOrEqual);
  }
}
export class Equal extends Comparison {
  public static OPERATOR = '==';

  public static parse = this.createParser(this);

  toString() {
    return this.stringify(Equal);
  }
}
export class NotEqual extends Comparison {
  public static OPERATOR = '!=';

  public static parse = this.createParser(this);

  toString() {
    return this.stringify(NotEqual);
  }
}

export abstract class Logic extends BinaryOperation {
  typeof() {
    return new BooleanType();
  }
}
export class And extends Logic {
  public static OPERATOR = '&&';

  public static parse = this.createParser(this);

  toString() {
    return this.stringify(And);
  }
}
export class Or extends Logic {
  public static OPERATOR = '||';

  public static parse = this.createParser(this);

  toString() {
    return this.stringify(Or);
  }
}
