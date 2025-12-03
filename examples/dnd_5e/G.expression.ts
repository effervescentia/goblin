/* eslint-disable @typescript-eslint/no-explicit-any */

import { AnyRecord, Goblin } from './G';
import { Selector } from './G.selector';

export class ExpressionStatic {
  public add(lhs: Goblin.Value<number>, rhs: Goblin.Value<number>) {
    return new Add(lhs, rhs);
  }

  public append<T>(lhs: Goblin.Value<T[]>, rhs: Goblin.Value<T>) {
    return new Append(lhs, rhs);
  }

  public include<T>(lhs: Goblin.Value<T[]>, rhs: Goblin.Value<T>) {
    return new Include(lhs, rhs);
  }
}

export abstract class Expression<T> {
  public static of<T>(value: Goblin.Value<T>): Expression<T> {
    if (value instanceof Expression) {
      return value;
    }

    if (value instanceof Goblin.Impl) {
      throw new Error('unimplemented');
    }

    if (value instanceof Selector) {
      return new Selection(value);
    }

    return new Static(value as T);
  }

  protected readonly __type!: T;
  protected __expression: true;
}

export class Static<T> extends Expression<T> {
  constructor(private value: T) {
    super();
  }
}

export class Selection<T> extends Expression<T> {
  constructor(private selector: Selector<any, T>) {
    super();
  }
}

export abstract class BinaryExpression<L, R = L, P = L> extends Expression<P> {
  private readonly lhs: Expression<L>;
  private readonly rhs: Expression<R>;

  constructor(lhs: Goblin.Value<L>, rhs: Goblin.Value<R>) {
    super();
    this.lhs = Expression.of(lhs);
    this.rhs = Expression.of(rhs);
  }
}

export class Add extends BinaryExpression<number> {}

export class Append<T> extends BinaryExpression<T[], T> {}

export class Include<T> extends BinaryExpression<T[], T> {}
