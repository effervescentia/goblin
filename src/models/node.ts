import { Expression } from '../language/expression';
import { Language } from '../language/parser';
import { BooleanType, EnumType, NumberType, StringType, Type } from './type';

class ValueNotImplemented extends Error {}
class UnexpectedType extends Error {
  constructor(type: string) {
    super(`unexpected type: ${type}`);
  }
}

export abstract class Node {
  public static from(data: unknown): Node {
    if (typeof data === 'boolean') {
      return new BooleanNode(data);
    } else if (typeof data === 'number') {
      return new NumberNode(data);
    } else if (typeof data === 'string') {
      return StringNode.from(data);
    } else if (Array.isArray(data)) {
      return new ArrayNode(data.map(Node.from));
    } else {
      if (data == null) {
        throw new ValueNotImplemented();
      } else {
        return ObjectNode.from(data);
      }
    }
  }

  public static newline(indent: number) {
    return `\n${'  '.repeat(indent)}`;
  }

  #type: Type | null = null;

  // get type() {
  //   return this.#type ?? (this.#type = this.typeof());
  // }

  // public abstract typeof(): Type;

  public abstract toString(indent?: number): string;
}

export class BooleanNode extends Node {
  constructor(public readonly value: boolean) {
    super();
  }

  typeof() {
    return new BooleanType();
  }

  toString() {
    return `${BooleanNode.name}(${this.value})`;
  }
}

export class NumberNode extends Node {
  constructor(public readonly value: number) {
    super();
  }

  typeof() {
    return new NumberType();
  }

  toString() {
    return `${NumberNode.name}(${this.value})`;
  }
}

export class StringNode extends Node {
  public static from(data: string): Node {
    if (data.startsWith('{') && data.endsWith('}')) {
      return new ExpressionNode(data.slice(1, -1));
    } else {
      return new StringNode(data);
    }
  }

  private constructor(public readonly value: string) {
    super();
  }

  typeof() {
    return new StringType();
  }

  toString() {
    return `${StringNode.name}("${this.value}")`;
  }
}

export class ExpressionNode extends Node {
  public readonly expression: Expression;

  constructor(public readonly text: string) {
    super();
    this.expression = Language.parse(text);
  }

  toString(_indent?: number) {
    return `${ExpressionNode.name}(${this.expression.toString()})`;
  }
}

export class ArrayNode extends Node {
  public static stringify(items: Node[], indent: number) {
    if (!items.length) return '[]';

    const newline = Node.newline(++indent);
    return `[${newline}${items
      .map((node) => node.toString(indent))
      .join(`,${newline}`)}${Node.newline(--indent)}]`;
  }

  constructor(public readonly items: Node[]) {
    super();
  }

  toString(indent = 0) {
    return `${ArrayNode.name}(${ArrayNode.stringify(this.items, indent)})`;
  }
}

export class ObjectNode extends Node {
  public static from(data: object): Node {
    const properties = Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, Node.from(value)]),
    );

    return (
      EnumMacro.try(properties) ??
      TypeMacro.try(properties) ??
      FunctionMacro.try(properties) ??
      TemplateMacro.try(properties) ??
      InitializeMacro.try(properties) ??
      new ObjectNode(properties)
    );
  }

  public static stringify(properties: Record<string, Node>, indent: number) {
    const entries = Object.entries(properties);
    if (!entries.length) return '{}';

    const newline = Node.newline(++indent);
    return `{${newline}${Object.entries(properties)
      .map(([key, node]) => `${key}: ${node.toString(indent)}`)
      .join(`,${newline}`)}${Node.newline(--indent)}}`;
  }

  private constructor(public readonly properties: Record<string, Node>) {
    super();
  }

  // typeof() {
  //   return new ObjectType(
  //     Object.fromEntries(
  //       Object.entries(this.value).map(([key, value]) => [key, value.typeof()]),
  //     ),
  //   );
  // }

  toString(indent = 0) {
    return `${ObjectNode.name}(${ObjectNode.stringify(
      this.properties,
      indent,
    )})`;
  }
}

class InvalidMacro extends Error {
  constructor(macro: string, node: Node) {
    super(`invalid ${macro} node: ${node.toString()}`);
  }
}

export abstract class MacroNode extends Node {}

export class EnumMacro extends MacroNode {
  private static KEY = '$enum';

  public static try(data: Record<string, Node>): EnumMacro | null {
    const node = data[this.KEY];
    if (!node) return null;
    if (!(node instanceof ArrayNode)) throw new InvalidMacro(this.KEY, node);

    return new EnumMacro(node.items);
  }

  private constructor(public readonly variants: Node[]) {
    super();
  }

  typeof() {
    return new EnumType(this);
  }

  toString(indent = 0) {
    const newline = Node.newline(++indent);
    return `${EnumMacro.name}(${newline}${this.variants
      .map((variant) => `| ${variant.toString(indent)}`)
      .join(newline)}${Node.newline(--indent)})`;
  }
}

export class TypeMacro extends MacroNode {
  private static KEY = '$type';

  public static try(data: Record<string, Node>): TypeMacro | null {
    const node = data[this.KEY];
    if (!node) return null;
    if (!(node instanceof StringNode || node instanceof ExpressionNode))
      throw new InvalidMacro(this.KEY, node);

    // TODO: validate expression separately?

    return new TypeMacro(node);
  }

  private constructor(public readonly type: StringNode | ExpressionNode) {
    super();
  }

  // typeof() {
  //   if (this.node instanceof StringNode) {
  //     switch (this.node.value) {
  //       case 'boolean':
  //         return new BooleanType();
  //       case 'number':
  //         return new NumberType();
  //       case 'string':
  //         return new StringType();
  //       default:
  //         throw new UnexpectedType(this.node.value);
  //     }
  //   }

  //   throw new UnexpectedType(this.node.typeof());
  // }

  toString(indent = 0) {
    return `${TypeMacro.name}(${this.type.toString(indent)})`;
  }
}

export class ParameterMacro extends MacroNode {
  private static NAME_PATTERN = /^:\w+/;

  public static try(name: string, type: Node): ParameterMacro | null {
    if (!name.match(this.NAME_PATTERN)) return null;
    if (!(type instanceof TypeMacro)) throw new InvalidMacro(name, type);

    return new ParameterMacro(name.slice(1), type);
  }

  public static extract(
    data: Record<string, Node>,
  ): Record<string, ParameterMacro> {
    return Object.fromEntries(
      Object.entries(data).flatMap(([key, value]) => {
        const parameter = ParameterMacro.try(key, value);
        return parameter ? [[parameter.name, parameter]] : [];
      }),
    );
  }

  private constructor(
    public readonly name: string,
    public readonly type: TypeMacro,
  ) {
    super();
  }

  toString(indent = 0) {
    return `${ParameterMacro.name}(${this.name}: ${this.type.toString(
      indent,
    )})`;
  }
}

export class FunctionMacro extends MacroNode {
  private static KEY = '$func';

  public static try(data: Record<string, Node>): FunctionMacro | null {
    const node = data[this.KEY];
    if (!node) return null;
    if (!(node instanceof ExpressionNode))
      throw new InvalidMacro(this.KEY, node);

    // TODO: validate expression separately?

    return new FunctionMacro(ParameterMacro.extract(data), node);
  }

  public static stringify(
    parameters: Record<string, Node>,
    template: Node,
    indent: number,
  ) {
    return `${ObjectNode.stringify(
      parameters,
      indent,
    )} -> ${template.toString()}`;
  }

  private constructor(
    public readonly parameters: Record<string, Node>,
    public readonly template: ExpressionNode,
  ) {
    super();
  }

  toString(indent = 0) {
    return `${FunctionMacro.name}(${FunctionMacro.stringify(
      this.parameters,
      this.template,
      indent,
    )})`;
  }
}

export class TemplateMacro extends MacroNode {
  private static KEY = '$tmpl';

  public static try(data: Record<string, Node>): TemplateMacro | null {
    const node = data[this.KEY];
    if (!node) return null;

    // TODO: validate expression separately?

    return new TemplateMacro(ParameterMacro.extract(data), node);
  }

  private constructor(
    public readonly parameters: Record<string, Node>,
    public readonly template: Node,
  ) {
    super();
  }

  toString(indent = 0) {
    return `${TemplateMacro.name}(${FunctionMacro.stringify(
      this.parameters,
      this.template,
      indent,
    )})`;
  }
}

export class InitializeMacro extends MacroNode {
  private static KEY = '$init';

  public static try(data: Record<string, Node>): InitializeMacro | null {
    const { [this.KEY]: node, ...arguments_ } = data;
    if (!node) return null;
    if (!(node instanceof ExpressionNode))
      throw new InvalidMacro(this.KEY, node);

    // TODO: validate expression separately?

    return new InitializeMacro(node, arguments_);
  }

  private constructor(
    public readonly template: ExpressionNode,
    public readonly arguments_: Record<string, Node>,
  ) {
    super();
  }

  toString(indent = 0) {
    return `${InitializeMacro.name}(${FunctionMacro.stringify(
      this.arguments_,
      this.template,
      indent,
    )})`;
  }
}
