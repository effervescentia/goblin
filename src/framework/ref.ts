export type UniversalRef = Array<number | string | AppRef | ScopeRef | LibraryRef>;

export abstract class NodeRef {
  constructor(public readonly path: Array<number | string>) {}
}

export class LibraryNodeRef extends NodeRef {}

export class DocumentNodeRef extends NodeRef {
  constructor(
    public readonly file: string,
    path: Array<number | string>,
  ) {
    super(path);
  }
}

export class ValueRef<T> {
  constructor(public readonly data: T) {}
}

export abstract class DependentRef<T> extends ValueRef<T> {
  constructor(
    data: T,
    public readonly dependencies: NodeRef[],
  ) {
    super(data);
  }
}

export class PromiseRef<T> extends DependentRef<() => Promise<T> | T> {
  async evaluate() {
    return this.data();
  }
}

export class FunctionRef<A extends unknown[], R> extends DependentRef<(...args: A) => R> {}

export class AppRef {}

export class ScopeRef {}

export class LibraryRef {}
