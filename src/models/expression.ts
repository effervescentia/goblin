import { BooleanType, NumberType, StringType, Type } from './type';

export abstract class Expression {
  // public abstract typeof(): Type;
}

export class Primitive extends Expression {
  constructor(public readonly value: boolean | number | string) {
    super();
  }

  typeof() {
    if (typeof this.value === 'boolean') {
      return new BooleanType();
    } else if (typeof this.value === 'number') {
      return new NumberType();
    } else if (typeof this.value === 'string') {
      return new StringType();
    } else {
      throw new Error(`unexpected value: ${this.value}`);
    }
  }
}

export abstract class BinaryOperation extends Expression {
  constructor(
    public readonly lhs: Expression,
    public readonly rhs: Expression,
  ) {
    super();
  }
}

export class Arithmetic extends BinaryOperation {
  typeof() {
    return new NumberType();
  }
}
export class Add extends Arithmetic {}
export class Subtract extends Arithmetic {}
export class Multiply extends Arithmetic {}
export class Divide extends Arithmetic {}

export class Comparison extends BinaryOperation {
  typeof() {
    return new BooleanType();
  }
}
export class LessThan extends Comparison {}
export class LessOrEqual extends Comparison {}
export class GreaterThan extends Comparison {}
export class GreaterOrEqual extends Comparison {}

export class Logic extends BinaryOperation {
  typeof() {
    return new BooleanType();
  }
}
export class And extends Logic {}
export class Or extends Logic {}

export class Argument extends Expression {
  constructor(public readonly type: Type) {
    super();
  }

  typeof() {
    return this.type;
  }
}

export class DotAccess extends Expression {
  constructor(
    public readonly object: Expression,
    public readonly property: string,
  ) {
    super();
  }
}

export class FunctionCall extends Expression {
  constructor(
    public readonly function_: Expression,
    public readonly arguments_: Expression[],
  ) {
    super();
  }
}
