import { match, P } from 'ts-pattern';
import type { NodeContext } from './context';
import type { DieRoll } from './die';
import { AppRef, type DocumentNodeRef, LibraryNodeRef, LibraryRef, ScopeRef, type UniversalRef } from './ref';
import type { Scope } from './scope';
import {
  AsteriskToken,
  AtSignToken,
  CloseParenthesisToken,
  CommaToken,
  DieRollToken,
  DigitsToken,
  DollarSignToken,
  EqualSignToken,
  ForwardSlashToken,
  MinusSignToken,
  OctothorpeToken,
  OpenParenthesisToken,
  PeriodToken,
  PlusSignToken,
  Token,
  WordToken,
} from './token';

export abstract class Expression {
  private static parse(input: Token[], prev: Expression | null = null): [Token[], Expression | null] {
    if (!input.length) return [[], prev];

    const token = input[0]!;

    if (prev) {
      const result = match([prev, token])

        .with([P.instanceOf(ScopeReferenceExpression), P.instanceOf(WordToken)], ([, rhs]) => {
          return Expression.parse(input.slice(1), new DotAccessExpression(prev, rhs.text));
        })

        .with(
          P.intersection(
            [P.instanceOf(DotAccessExpression), P.instanceOf(OpenParenthesisToken)],
            P.when(() => input[1] instanceof CloseParenthesisToken),
          ),
          () => {
            return Expression.parse(input.slice(2), new FunctionCallExpression(prev, []));
          },
        )

        .with([P.instanceOf(DotAccessExpression), P.instanceOf(OpenParenthesisToken)], () => {
          let [tokens, expression] = Expression.parse(input.slice(1));

          if (expression) {
            const args = [expression];

            while (tokens[0] instanceof CommaToken) {
              [tokens, expression] = Expression.parse(tokens.slice(1));

              if (expression) {
                args.push(expression);
              } else {
                break;
              }
            }

            if (tokens[0] instanceof CloseParenthesisToken) {
              return Expression.parse(tokens.slice(1), new FunctionCallExpression(prev, args));
            }
          }

          throw new Error('expected function call arguments');
        })

        .with(
          P.intersection(
            [
              P.union(
                P.instanceOf(LibraryReferenceExpression),
                P.instanceOf(AppReferenceExpression),
                P.instanceOf(ActorReferenceExpression),
                P.instanceOf(DotAccessExpression),
              ),
              P.instanceOf(PeriodToken),
            ],
            P.when(() => input[1] instanceof WordToken),
          ),
          () => {
            return Expression.parse(input.slice(2), new DotAccessExpression(prev, (input[1] as WordToken).text));
          },
        )

        .with(
          [
            P.any,
            P.union(
              P.instanceOf(PlusSignToken),
              P.instanceOf(MinusSignToken),
              P.instanceOf(AsteriskToken),
              P.instanceOf(ForwardSlashToken),
              P.instanceOf(EqualSignToken),
            ),
          ],
          ([, operator]) => {
            const [tokens, expression] = Expression.parse(input.slice(1));

            if (expression) {
              return Expression.parse(
                tokens,
                match(operator)
                  .with(P.instanceOf(PlusSignToken), () => new AddExpression(prev, expression))
                  .with(P.instanceOf(MinusSignToken), () => new SubtractExpression(prev, expression))
                  .with(P.instanceOf(AsteriskToken), () => new MultiplyExpression(prev, expression))
                  .with(P.instanceOf(ForwardSlashToken), () => new DivideExpression(prev, expression))
                  .with(P.instanceOf(EqualSignToken), () => new AssignExpression(prev, expression))
                  .exhaustive(),
              );
            }

            throw new Error('expected right-hand-side expression');
          },
        )

        .otherwise(() => null);

      if (result) return result;
    } else {
      const result = match(token)

        .with(P.instanceOf(DollarSignToken), () => Expression.parse(input.slice(1), new LibraryReferenceExpression()))

        .with(P.instanceOf(AtSignToken), () => Expression.parse(input.slice(1), new AppReferenceExpression()))

        .with(P.instanceOf(OctothorpeToken), () => Expression.parse(input.slice(1), new ActorReferenceExpression()))

        .with(P.instanceOf(PeriodToken), () => Expression.parse(input.slice(1), new ScopeReferenceExpression()))

        .with(P.instanceOf(DieRollToken), ({ dieRoll }) =>
          Expression.parse(input.slice(1), new DieRollExpression(dieRoll)),
        )

        .with(P.instanceOf(DigitsToken), (digits) =>
          Expression.parse(input.slice(1), new IntegerExpression(Number(digits.text))),
        )

        .with(P.instanceOf(WordToken), (word) => Expression.parse(input.slice(1), new IdentifierExpression(word.text)))

        .with(P.instanceOf(OpenParenthesisToken), () => {
          const [tokens, expression] = Expression.parse(input.slice(1));

          if (!expression) {
            throw new Error('expected expression after open parenthesis');
          }

          if (tokens[0] instanceof CloseParenthesisToken) {
            return [tokens.slice(1), expression] as [Token[], Expression];
          }

          throw new Error('expected close parenthesis after expression');
        })

        .otherwise(() => null);

      if (result) return result;
    }

    return [input, prev];
  }

  public static safeParse(data: string) {
    try {
      const [tokens, expression] = Expression.parse(Token.tokenize(data));

      if (!tokens.length && expression) return expression;
    } catch {
      return null;
    }
  }

  public dependencies(_context: NodeContext): Array<LibraryNodeRef | DocumentNodeRef> {
    return [];
  }

  public abstract execute(scope: Scope): unknown;

  public abstract toString(): string;
}

export class IntegerExpression extends Expression {
  constructor(public readonly value: number) {
    super();
  }

  public override execute() {
    return this.value;
  }

  public override toString() {
    return String(this.value);
  }
}

export abstract class ReferenceExpression extends Expression {}

export class IdentifierExpression extends ReferenceExpression {
  constructor(public readonly text: string) {
    super();
  }

  public override execute(scope: Scope) {
    if (this.text in scope.parameters) {
      return scope.parameters[this.text];
    }

    throw new Error(`parameter '${this.text}' not found`);
  }

  public override toString() {
    return this.text;
  }
}

export class LibraryReferenceExpression extends ReferenceExpression {
  public override execute() {
    throw new Error('do not execute directly');
  }

  public override toString() {
    return '$';
  }
}

export class AppReferenceExpression extends ReferenceExpression {
  public override execute() {
    throw new Error('do not execute directly');
  }

  public override toString() {
    return '@';
  }
}

export class ActorReferenceExpression extends ReferenceExpression {
  public override execute() {
    throw new Error('do not execute directly');
  }

  public override toString() {
    return '#';
  }
}

export class ScopeReferenceExpression extends ReferenceExpression {
  public override execute() {
    throw new Error('do not execute directly');
  }

  public override toString() {
    return '.';
  }
}

export class DotAccessExpression extends ReferenceExpression {
  constructor(
    public readonly lhs: Expression,
    public readonly rhs: string,
  ) {
    super();
  }

  private get path(): UniversalRef {
    return match(this.lhs)

      .with(P.instanceOf(DotAccessExpression), (dotAccess) => {
        const lhs = dotAccess.path;
        return lhs.length ? [...lhs, this.rhs] : [];
      })

      .with(P.instanceOf(AppReferenceExpression), () => [new AppRef(), this.rhs])

      .with(P.instanceOf(ScopeReferenceExpression), () => [new ScopeRef(), this.rhs])

      .with(P.instanceOf(LibraryReferenceExpression), () => [new LibraryRef(), this.rhs])

      .with(P.instanceOf(IdentifierExpression), () => [])

      .otherwise(() => []);
  }

  public override execute(scope: Scope) {
    return scope.context.resolve(scope.context.reference(this.path));
  }

  public override dependencies(context: NodeContext) {
    const path = this.path;
    return path.length ? [context.reference(path)] : [];
  }

  public override toString() {
    if (this.lhs instanceof ScopeReferenceExpression) return `.${this.rhs}`;

    return `${this.lhs}.${this.rhs}`;
  }
}

export class FunctionCallExpression extends Expression {
  constructor(
    public readonly lhs: Expression,
    public readonly args: Expression[],
  ) {
    super();
  }

  public override execute(scope: Scope) {
    const lhs = this.lhs.execute(scope);
    const args = this.args.map((arg) => arg.execute(scope));

    return (lhs as (...args: unknown[]) => unknown)(...args);
  }

  public override dependencies(_context: NodeContext) {
    return [this.lhs.dependencies(_context), this.args.flatMap((arg) => arg.dependencies(_context))].flat();
  }

  public override toString() {
    return `${this.lhs}(${this.args.map((arg) => arg.toString()).join(', ')})`;
  }
}

export abstract class BinaryExpression extends Expression {
  protected abstract operator: string;

  constructor(
    protected readonly lhs: Expression,
    protected readonly rhs: Expression,
  ) {
    super();
  }

  public override dependencies(context: NodeContext) {
    return [this.lhs.dependencies(context), this.rhs.dependencies(context)].flat();
  }

  public override toString() {
    return `${this.lhs} ${this.operator} ${this.rhs}`;
  }
}

export class AssignExpression extends BinaryExpression {
  protected override operator = '=';

  public override execute() {
    return null;
  }
}

export abstract class ArithmeticExpression extends BinaryExpression {
  protected abstract apply(lhs: number, rhs: number): number;

  public override execute(scope: Scope) {
    const lhs = this.lhs.execute(scope);
    const rhs = this.rhs.execute(scope);

    if (typeof lhs !== 'number' || typeof rhs !== 'number') {
      throw new Error(`failed to apply '${this.operator}' operator to one or more non-numeric values`);
    }

    return this.apply(lhs, rhs);
  }
}

export class AddExpression extends ArithmeticExpression {
  protected override operator = '+';

  protected override apply(lhs: number, rhs: number) {
    return lhs + rhs;
  }
}

export class SubtractExpression extends ArithmeticExpression {
  protected override operator = '-';

  protected override apply(lhs: number, rhs: number) {
    return lhs - rhs;
  }
}

export class MultiplyExpression extends ArithmeticExpression {
  protected override operator = '*';

  protected override apply(lhs: number, rhs: number) {
    return lhs * rhs;
  }
}

export class DivideExpression extends ArithmeticExpression {
  protected override operator = '/';

  protected override apply(lhs: number, rhs: number) {
    return lhs / rhs;
  }
}

export class DieRollExpression extends Expression {
  constructor(public readonly dieRoll: DieRoll) {
    super();
  }

  public override execute() {
    return this.dieRoll.execute();
  }

  public override toString() {
    return this.dieRoll.toString();
  }
}
