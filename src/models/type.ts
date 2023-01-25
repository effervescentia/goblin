export abstract class Type {
  public abstract toString(): string;
}

export class BooleanType extends Type {
  public toString() {
    return 'boolean';
  }
}

export class NumberType extends Type {
  public toString() {
    return 'number';
  }
}

export class StringType extends Type {
  public toString() {
    return 'string';
  }
}

export class ArrayType extends Type {
  constructor(public readonly type: Type) {
    super();
  }

  public toString() {
    return `${this.type.toString()}[]`;
  }
}

export class ObjectType extends Type {
  constructor(public readonly properties: Record<string, Type>) {
    super();
  }

  public toString() {
    return `{ ${Object.entries(this.properties)
      .map(([key, type]) => `${key}: ${type.toString()}`)
      .join(', ')} }`;
  }
}

export class EnumType extends Type {
  constructor(public readonly reference: unknown) {
    super();
  }

  public toString() {
    return `(unique)`;
  }
}
