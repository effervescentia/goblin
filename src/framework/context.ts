import { memoize } from 'micro-memoize';
import { traverse } from 'radashi';
import { match, P } from 'ts-pattern';
import type { App } from './app';
import LIBRARY from './library';
import {
  AppRef,
  DocumentNodeRef,
  FunctionRef,
  LibraryNodeRef,
  LibraryRef,
  PromiseRef,
  ScopeRef,
  type UniversalRef,
  ValueRef,
} from './ref';

type Serialized = Record<number | string, unknown>;

const setDeep = (target: Serialized, path: Array<number | string>, data: unknown) => {
  const [key, ...rest] = path;

  if (key === undefined) return;

  target[key] ??= rest.length ? {} : data;

  setDeep(target[key] as Serialized, rest, data);
};

export class AppContext {
  public readonly nodes = new Map<DocumentNodeRef, ValueRef<unknown>>();
  public readonly values = new Map<LibraryNodeRef | DocumentNodeRef, unknown>();

  public readonly libraryRef = memoize((path: Array<number | string>) => new LibraryNodeRef(path), {
    maxSize: Number.MAX_SAFE_INTEGER,
    isKeyItemEqual: 'shallow',
  });

  public readonly nodeRef = memoize((file: string, path: Array<number | string>) => new DocumentNodeRef(file, path), {
    maxSize: Number.MAX_SAFE_INTEGER,
    isKeyItemEqual: 'shallow',
  });

  constructor(public readonly app: App) {
    traverse(LIBRARY, (value, _key, _parent, context) => {
      if (typeof value === 'function') {
        this.values.set(this.libraryRef([...context.path] as Array<number | string>), value);
      }
    });
  }

  public async solve() {
    const unprocessed = new Map(this.nodes);

    while (unprocessed.size > 0) {
      const sizeBefore = unprocessed.size;

      for (const [key, node] of unprocessed) {
        await match(node)

          .with(P.union(P.instanceOf(FunctionRef), P.instanceOf(PromiseRef)), async (dependent) => {
            if (dependent.dependencies.every((ref) => this.values.has(ref))) {
              await match(dependent)

                .with(P.instanceOf(PromiseRef), async (promise) => {
                  unprocessed.delete(key);
                  this.values.set(key, await promise.evaluate());
                })

                .with(P.instanceOf(FunctionRef), (function_) => {
                  unprocessed.delete(key);
                  this.values.set(key, function_.data);
                })

                .exhaustive();
            }
          })

          .with(P.instanceOf(ValueRef), (value) => {
            unprocessed.delete(key);
            this.values.set(key, value.data);
          })

          .exhaustive();
      }

      if (sizeBefore === unprocessed.size) {
        console.log('unprocessable nodes', unprocessed, this.values);

        throw new Error('failed to solve');
      }
    }
  }

  public serialize() {
    const data: Serialized = {};

    this.values.entries().forEach(([ref, value]) => {
      if (ref instanceof LibraryNodeRef || typeof value === 'function') return;

      setDeep(data, [ref.file, ...ref.path], value);
    });

    return data;
  }

  public document(file: string) {
    return new DocumentContext(this, file);
  }
}

export class DocumentContext {
  constructor(
    private readonly appContext: AppContext,
    public readonly file: string,
  ) {}

  public get app() {
    return this.appContext.app;
  }

  public get libraryRef() {
    return this.appContext.libraryRef;
  }

  public get nodeRef() {
    return this.appContext.nodeRef;
  }

  public get nodes() {
    return this.appContext.nodes;
  }

  public get values() {
    return this.appContext.values;
  }

  public node(path: string[] = []) {
    return new NodeContext(this, path);
  }
}

export class NodeContext {
  constructor(
    private readonly documentContext: DocumentContext,
    private readonly path: Array<number | string>,
  ) {}

  public get app() {
    return this.documentContext.app;
  }

  public get libraryRef() {
    return this.documentContext.libraryRef;
  }

  public get nodeRef() {
    return this.documentContext.nodeRef;
  }

  public get nodes() {
    return this.documentContext.nodes;
  }

  public get values() {
    return this.documentContext.values;
  }

  public get ref() {
    return this.nodeRef(this.documentContext.file, this.path);
  }

  public register<T>(value: ValueRef<T>) {
    this.nodes.set(this.ref, value);
  }

  public resolve(ref: LibraryNodeRef | DocumentNodeRef = this.ref) {
    return this.values.get(ref);
  }

  public reference(path: UniversalRef) {
    if (path[0] instanceof AppRef) {
      return this.nodeRef(this.app.file, path.slice(1) as Array<number | string>);
    }

    if (path[0] instanceof ScopeRef) {
      return this.nodeRef(
        this.documentContext.file,
        [this.path.slice(0, -1), path.slice(1)].flat() as Array<number | string>,
      );
    }

    if (path[0] instanceof LibraryRef) {
      return this.libraryRef(path.slice(1) as Array<number | string>);
    }

    return this.nodeRef(this.documentContext.file, path as Array<number | string>);
  }

  public child(key: number | string) {
    return new NodeContext(this.documentContext, [...this.path, key]);
  }
}
