import indentString from 'indent-string';
import type { NodeContext } from './context';
import { Die } from './die';
import type { Document } from './document';
import { Expression, IdentifierExpression } from './expression';
import { FunctionRef, PromiseRef, ValueRef } from './ref';
import { Scope } from './scope';

export abstract class Node<T = unknown> {
  public static parse(document: Document, data: unknown): Node {
    if (typeof data === 'boolean') return new BooleanNode(document, data);

    if (typeof data === 'number') return new NumberNode(document, data);

    if (typeof data === 'string') {
      return (
        DieNode.safeParse(document, data) ?? ExpressionNode.safeParse(document, data) ?? new StringNode(document, data)
      );
    }

    if (data == null || typeof data !== 'object') return new UnexpectedNode(document, data);

    if (Array.isArray(data)) {
      return new ListNode(document, data);
    }

    return new RecordNode(document, data);
  }

  constructor(
    public readonly document: Document,
    protected readonly rawData: T,
  ) {}

  protected tagged(data: unknown) {
    return `${this.constructor.name}(${data})`;
  }

  public isReady() {
    return true;
  }

  public isValid() {
    return true;
  }

  public register(context: NodeContext) {
    context.register(new ValueRef(this.rawData));
  }

  public serialize(context: NodeContext) {
    return context.resolve();
  }

  public toString() {
    return this.tagged(this.rawData);
  }
}

export class UnexpectedNode extends Node {
  public override isValid() {
    return false;
  }
}

export class BooleanNode extends Node<boolean> {}

export class NumberNode extends Node<number> {}

export class StringNode extends Node<string> {}

export class DieNode extends StringNode {
  private static readonly PATTERN = /^d(?<sides>\d+)$/;

  public static safeParse(document: Document, data: string) {
    const match = data.match(DieNode.PATTERN);
    if (!match?.groups) return null;

    return new DieNode(document, data, new Die(Number(match.groups.sides)));
  }

  constructor(
    document: Document,
    rawData: string,
    public readonly die: Die,
  ) {
    super(document, rawData);
  }

  public override register(context: NodeContext) {
    context.register(new ValueRef({ $Die: this.die.toString() }));
  }

  public override toString() {
    return this.tagged(this.die);
  }
}

export class ExpressionNode extends StringNode {
  public static safeParse(document: Document, data: string) {
    const expression = Expression.safeParse(data);
    if (!expression || expression instanceof IdentifierExpression) return null;

    return new ExpressionNode(document, data, expression);
  }

  constructor(
    document: Document,
    rawData: string,
    public readonly expression: Expression,
  ) {
    super(document, rawData);
  }

  public override register(context: NodeContext) {
    const dependencies = this.expression.dependencies(context);

    context.register(new PromiseRef(() => this.expression.execute(new Scope(this, context)), dependencies));
  }

  public override toString() {
    return this.tagged(this.expression);
  }
}

export class ListNode extends Node<unknown[]> {
  public readonly list = this.rawData.map(this.document.node);

  public override isReady() {
    return this.list.every((node) => node.isReady());
  }

  public override isValid() {
    return this.list.every((node) => node.isValid());
  }

  public override register(context: NodeContext) {
    this.list.forEach((node, index) => node.register(context.child(index)));
  }

  public override serialize(context: NodeContext) {
    return this.list.map((node, index) => node.serialize(context.child(index)));
  }

  public override toString() {
    if (!this.list.length) return this.tagged('[]');

    return this.tagged(`[${this.list.map(String).join(', ')}]`);
  }
}

export class RecordNode extends Node<object> {
  public readonly record = Object.fromEntries(
    Object.entries(this.rawData).map(([key, value]) => {
      const result = FunctionNode.safeParse(this.document, key, value);

      return result ?? [key, this.document.node(value)];
    }),
  );

  public override isReady() {
    return Object.values(this.record).every((node) => node.isReady());
  }

  public override isValid() {
    return Object.values(this.record).every((node) => node.isValid());
  }

  public override register(context: NodeContext) {
    Object.entries(this.record).forEach(([key, node]) => node.register(context.child(key)));
  }

  public override serialize(context: NodeContext) {
    return Object.fromEntries(
      Object.entries(this.record).map(([key, node]) => [key, node.serialize(context.child(key))]),
    );
  }

  public override toString() {
    if (!Object.keys(this.record).length) return this.tagged('{}');

    return this.tagged(
      `{\n${Object.entries(this.record)
        .map(([key, node]) => indentString(`${key}: ${node},\n`))
        .join('')}}`,
    );
  }
}

export class FunctionNode extends Node<[string[], string]> {
  public static readonly SIGNATURE = /^(?<name>[a-zA-Z_]\w*)\((?<parameters>(?:[a-zA-Z_]\w*\s*(?:,\s*)?)*)\)$/;

  public static safeParse(document: Document, signature: string, data: string) {
    const match = signature.match(FunctionNode.SIGNATURE);
    if (!match?.groups) return null;

    const expression = Expression.safeParse(data);
    if (!expression) return null;

    const parameters = match.groups.parameters!.split(',').map((text) => text.trim());
    return [match.groups.name!, new FunctionNode(document, [parameters, data], expression)] as const;
  }

  constructor(
    document: Document,
    rawData: [string[], string],
    public readonly expression: Expression,
  ) {
    super(document, rawData);
  }

  public override register(context: NodeContext) {
    const dependencies = this.expression.dependencies(context);

    context.register(
      new FunctionRef((...args: unknown[]) => {
        const data = Object.fromEntries(this.rawData[0].map((key, index) => [key, args[index]]));
        return this.expression.execute(new Scope(this, context, data));
      }, dependencies),
    );
  }

  public override toString() {
    return this.tagged(
      `(${this.rawData[0].map((parameter) => parameter.toString()).join(', ')}) -> ${this.rawData[1]}`,
    );
  }
}
