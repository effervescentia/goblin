/* eslint-disable @typescript-eslint/ban-types */
import * as P from 'parsimmon';

import { BooleanType, NumberType, StringType } from '../../models/type';

export abstract class Expression {
  // public abstract typeof(): Type;

  public abstract toString(): string;
}

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

export class Argument extends Expression {
  public static PREFIX = ':';
  public static PATTERN = new RegExp(`${this.PREFIX}(\\w+)`);

  public static parse = P.regex(this.PATTERN, 1).map(
    (name) => new Argument(name),
  );

  private constructor(public readonly name: string) {
    super();
  }

  // typeof() {
  //   return this.type;
  // }

  toString() {
    return `${Argument.name}(${this.name})`;
  }
}

export abstract class Reference extends Expression {
  public static SELF = '.';
  public static PARENT = '..';
}
export class FileReference extends Reference {
  public static ROOT = '@';
  public static SEPARATOR = '/';
  public static RELATIVE = new FileReference([this.SELF]);

  public static parse = P.alt(
    P.string(this.ROOT),
    P.string(this.PARENT),
    P.string(this.SELF),
  )
    .chain((base) =>
      P.seq(
        P.string(this.SEPARATOR),
        P.alt(P.regex(/\w+/), P.string(this.PARENT)),
      )
        .map(([, name]) => name)
        .atLeast(1)
        .map((rest) => [base, ...rest]),
    )
    .map((filePath) => new FileReference(filePath));

  private constructor(public readonly path: string[]) {
    super();
  }

  toString() {
    return `${FileReference.name}(${this.path.join(', ')})`;
  }
}
export class DataReference extends Reference {
  public static ROOT = '#';
  public static ROOT_PATTERN = new RegExp(`${this.ROOT}(\\w+)`);
  public static SEPARATOR = '.';

  private static parseAbsolute = P.seqMap(
    FileReference.parse.or(P.of(FileReference.RELATIVE)),
    P.regex(this.ROOT_PATTERN, 1).chain((base) =>
      P.seq(P.string(this.SEPARATOR), P.regex(/\w+/))
        .map(([, name]) => name)
        .many()
        .map((rest) => [this.ROOT, base, ...rest]),
    ),
    (file, path) => new DataReference(file, path),
  );

  private static parseRelative = P.string(this.SEPARATOR)
    .atLeast(1)
    .map((prefix) =>
      prefix.length === 1
        ? [this.SELF]
        : Array.from({ length: prefix.length - 1 }, () => this.PARENT),
    )
    .chain((base) =>
      P.regex(/\w+/)
        .sepBy1(P.string(this.SEPARATOR))
        .map(
          (path) =>
            new DataReference(FileReference.RELATIVE, [...base, ...path]),
        ),
    );

  public static parse = P.alt(this.parseAbsolute, this.parseRelative);

  private constructor(
    public readonly file: FileReference,
    public readonly path: string[],
  ) {
    super();
  }

  toString() {
    return `${DataReference.name}(${this.file.toString()}, ${this.path.join(
      ', ',
    )})`;
  }
}

export class DotAccess extends Expression {
  constructor(
    public readonly object: Expression,
    public readonly property: string,
  ) {
    super();
  }

  toString() {
    return `${DotAccess.name}(${this.object}, ${this.property})`;
  }
}

export class FunctionCall extends Expression {
  constructor(
    public readonly function_: Expression,
    public readonly arguments_: Expression[],
  ) {
    super();
  }

  toString() {
    return `${FunctionCall.name}(${this.function_}, [${this.arguments_
      .map((arg) => arg.toString())
      .join(', ')}])`;
  }
}
