/* eslint-disable @typescript-eslint/no-explicit-any */

import type { AnyRecord, Goblin } from './G';

export type Path = (number | string)[];

export interface Metadata<S extends AnyRecord> {
  root: Goblin.Type<S, any>;
  path: Path;
}

export type Selector<S extends AnyRecord, T> = (T extends object
  ? Readonly<{ [K in keyof T]: Selector<S, T[K]> }>
  : T) & {
  [METADATA]: Metadata<S>;
};

export type SelectorOf<T extends AnyRecord> = {
  [K in keyof T]: Selector<T, T[K]>;
};

const METADATA = Symbol('selector-metadata');

export const Selector = Object.assign(
  <S extends AnyRecord, T extends object>(
    root: Goblin.Type<S, any>,
    path: Path,
  ): Selector<S, T> => {
    return new Proxy({} as Selector<S, T>, {
      set: () => false,
      deleteProperty: () => false,
      get: (_, prop) => {
        if (prop === METADATA) return { root, path };

        return Selector(root, [...path, prop as string]);
      },
    });
  },
  {
    getMetadata: <S extends AnyRecord, T>(
      selector: Selector<S, T>,
    ): Metadata<S> => selector[METADATA],

    isSelector: (selector: any): selector is Selector<AnyRecord, any> =>
      !!selector[METADATA],
  },
);
