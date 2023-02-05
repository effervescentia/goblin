import { Expression } from './base';

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
