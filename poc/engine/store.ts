export type State = Map<string, unknown>;

export class ArrayRef {
  constructor(public readonly length: number) {}
}

export class ObjectRef {
  constructor(public readonly keys: Set<string>) {}
}

export class Store {
  private static tail(path: string) {
    const index = path.lastIndexOf('.');
    return index === -1
      ? ([path] as const)
      : ([path.slice(0, index), path.slice(index + 1)] as const);
  }

  private static set(store: Store, path: string, data: unknown) {
    const [root, leaf] = Store.tail(path);

    if (leaf) {
      const parent = store.state.get(root);
      if (parent instanceof ArrayRef) {
        const index = Number(leaf);
        if (index >= parent.length) {
          store.state.set(root, new ArrayRef(index + 1));
        }
      } else if (parent instanceof ObjectRef) {
        if (!parent.keys.has(leaf)) {
          store.state.set(root, new ObjectRef(new Set([...parent.keys, leaf])));
        }
      }
    } else {
      store.keys.add(path);
    }

    const set = (path: string, data: unknown) => {
      if (Array.isArray(data)) {
        store.state.set(path, new ArrayRef(data.length));
        data.forEach((value, index) => set(`${path}.${index}`, value));
      } else if (!!data && typeof data === 'object') {
        store.state.set(path, new ObjectRef(new Set(Object.keys(data))));
        Object.entries(data).forEach(([key, value]) =>
          set(`${path}.${key}`, value),
        );
      } else {
        store.state.set(path, data);
      }
    };

    set(path, data);
  }

  private static delete(store: Store, path: string) {
    const data = store.state.get(path);
    store.state.delete(path);

    const isRoot = !path.includes('.');
    if (isRoot) {
      store.keys.delete(path);
    }

    if (Array.isArray(data)) {
      data.forEach((_, index) => Store.delete(store, `${path}.${index}`));
    } else if (!!data && typeof data === 'object') {
      Object.keys(data).forEach((key) => Store.delete(store, `${path}.${key}`));
    }
  }

  private readonly state: State = new Map();
  private readonly keys = new Set<string>();

  constructor(store?: Store) {
    this.state = new Map(store?.state);
    this.keys = new Set(store?.keys);
  }

  private mutate(apply: (store: Store) => void) {
    const next = new Store(this);
    apply(next);
    return next;
  }

  public serialize(): Record<string, unknown> {
    return Object.fromEntries(
      Array.from(this.keys).map((key) => [key, this.state.get(key)]),
    );
  }

  public set(path: string, data: unknown): Store {
    return this.mutate((next) => {
      Store.delete(next, path);
      Store.set(next, path, data);
    });
  }

  public delete(path: string): Store {
    return this.mutate((next) => Store.delete(next, path));
  }
}
