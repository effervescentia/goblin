/* eslint-disable @typescript-eslint/no-namespace, @typescript-eslint/no-explicit-any, @typescript-eslint/ban-types */

import { Expression, ExpressionStatic } from './G.expression';
import { Selector, SelectorOf } from './G.selector';

export type AnyRecord = globalThis.Record<string, any>;

export class GoblinStatic {
  public readonly expr = new ExpressionStatic();

  private core<T>(context: T) {
    return new Goblin.Type.Core(context);
  }

  public enum<T extends string>(values: T[]) {
    return new Goblin.Enum(this.core(values));
  }

  public boolean() {
    return new Goblin.Boolean(this.core(null));
  }

  public number() {
    return new Goblin.Number(this.core(null));
  }

  public string() {
    return new Goblin.String(this.core(null));
  }

  public array<T>(definition: Goblin.Type<T>) {
    return new Goblin.Array(this.core(definition));
  }

  public record<K extends string, V>(
    key: Goblin.Type<K, any>,
    value: Goblin.Type<V, any>,
  ) {
    return new Goblin.Record<K, V>(this.core({ key, value }));
  }

  public object<T extends AnyRecord>(definition: Goblin.DefinitionOf<T>) {
    return new Goblin.Object(this.core(definition));
  }

  public struct<T extends AnyRecord>(definition: Goblin.DefinitionOf<T>) {
    return new Goblin.Struct(this.core(definition));
  }

  public scope<T extends AnyRecord>(definition: Goblin.DefinitionOf<T>) {
    return new Goblin.Scope<T>(this.core(definition));
  }

  public assign<T>(selector: Selector<any, T>, value: Goblin.Value<T>) {
    return new Goblin.Assign(selector, value);
  }

  // public modify<C extends GoblinContext<any>, T extends AnyGoblinType>(
  //   context: C,
  //   selector: (context: InstanceOf<C>) => T,
  // ) {
  //   return new GoblinModify(context, selector);
  // }

  // public choose<T extends AnyGoblinType, C extends number>(
  //   count: number,
  //   options: T[],
  // ): GoblinChooseMany<T>;
  // public choose<T extends AnyGoblinType, C extends number>(
  //   options: T[],
  // ): GoblinChooseOne<T>;
  // public choose<T extends AnyGoblinType>(
  //   count_or_options: number | T[],
  //   options?: T[],
  // ) {
  //   if (Array.isArray(count_or_options)) {
  //     return new GoblinChooseOne(count_or_options);
  //   } else if (Array.isArray(options)) {
  //     return new GoblinChooseMany(options, count_or_options);
  //   }
  // }
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Goblin {
  export type TypeOf<T> =
    | (T extends Any | Never ? never : T)
    | (T extends Primitive<infer U> ? U : never)
    | (T extends Enum<infer U> ? U : never)
    | (T extends Array<infer U> ? U[] : never)
    | (T extends Indexed<infer U, any> ? U : never);
  export type DefinitionOf<T> = {
    [K in keyof T]: Type<T[K], any>;
  };
  export type ImplOf<T> = Value<TypeOf<T>>;

  export type Value<T> =
    | T
    | Selector<any, T>
    | Expression<T>
    | (T extends AnyRecord ? Impl<T> : never);

  export type Any = Type<any, any>;

  export class Never {
    protected __never!: unknown;
  }

  class Core<C> {
    constructor(
      public readonly context: C,
      private readonly effects: Effect[] = [],
    ) {}

    public wrap<T>(context: T) {
      return new Core(context, this.effects);
    }

    public withEffects(effects: Effect[]) {
      return new Core(this.context, [...this.effects, ...effects]);
    }
  }

  export abstract class Type<T, C = null> {
    public static readonly Core = Core;

    private readonly __type!: T;
    protected readonly shape: Shape<T> = new Shape(
      globalThis.Object.getPrototypeOf(this),
    );

    constructor(protected readonly core: Core<C>) {}

    public array() {
      return new Array<T>(this.core.wrap(this));
    }

    public effects(...effects: Effect[]): this {
      return this.shape.create(this.core.withEffects(effects));
    }

    public ctor<F extends (...args: any[]) => T>(factory: F): this & { new: F };
    public ctor<F extends globalThis.Record<string, (...args: any[]) => T>>(
      factory: F,
    ): this & F;
    public ctor(factory: globalThis.Record<string, any> | Function): this {
      return globalThis.Object.assign(
        new Proxy(this, {}),
        typeof factory === 'function' ? { new: factory } : factory,
      );
    }
  }

  export class Shape<T> {
    private readonly __type!: T;

    constructor(private ctor: new (core: Core<any>) => Type<T, any>) {}

    public create<C, U extends Type<T, any>>(core: Core<C>) {
      return new this.ctor(core) as U;
    }
  }

  export class Enum<T extends string> extends Type<T, T[]> {
    public $ = globalThis.Object.fromEntries(
      this.core.context.map((key) => [key, key]),
    ) as {
      [K in T]: K;
    };
  }

  export abstract class Primitive<T> extends Type<T> {}

  export class Boolean extends Primitive<boolean> {}

  export class Number extends Primitive<number> {}

  export class String extends Primitive<string> {}

  export class Array<T> extends Type<T[], Type<T, any>> {}

  export abstract class Indexed<
    T extends AnyRecord,
    C = DefinitionOf<T>,
  > extends Type<T, C> {
    protected __indexed!: true;
  }

  export interface RecordContext<K extends string, V> {
    key: Type<K, any>;
    value: Type<V, any>;
  }

  export class Record<K extends string, V> extends Indexed<
    globalThis.Record<K, V>,
    RecordContext<K, V>
  > {}

  export abstract class Extensible<
    T extends AnyRecord,
    C = DefinitionOf<T>,
  > extends Indexed<T, C> {
    public extend<U extends AnyRecord>(
      extension: DefinitionOf<U>,
    ): Type<T & U, any> {
      return this.shape.create(this.extendState(extension));
    }

    protected extendState<U extends AnyRecord>(extension: DefinitionOf<U>) {
      return this.core.wrap({
        ...this.core.context,
        ...extension,
      } as DefinitionOf<T & U>);
    }
  }

  export class Object<T extends AnyRecord> extends Extensible<T> {}

  export abstract class Target<T extends AnyRecord> extends Extensible<T> {
    public $ = this.selectors();

    protected selectors() {
      return globalThis.Object.fromEntries(
        globalThis.Object.keys(this.core.context).map((key) => [
          key,
          Selector<T, any>(this, [key]),
        ]),
      ) as SelectorOf<T>;
    }

    public mutate(factory: EffectFactory<T>) {
      return factory(this.$);
    }
  }

  export type EffectFactory<T extends AnyRecord> = ($: SelectorOf<T>) => Effect;

  export type MutatorMap<T extends AnyRecord> = globalThis.Record<
    string,
    (selector: SelectorOf<T>) => (...args: any[]) => Effect
  >;

  export type BoundMutators<T extends AnyRecord, M extends MutatorMap<T>> = {
    [K in keyof M]: (...args: Parameters<ReturnType<M[K]>>) => Effect;
  };

  export class Struct<T extends AnyRecord> extends Target<T> {
    public impl(impl: T) {
      return new Impl(this.core.wrap({ struct: this, impl }));
    }

    public mutators<M extends MutatorMap<T>>(
      mutators: M,
    ): this & BoundMutators<T, M> {
      return globalThis.Object.assign(
        new Proxy(this, {}),
        globalThis.Object.fromEntries(
          globalThis.Object.entries(mutators).map(([key, effect]) => [
            key,
            (...args: any[]) => effect(this.$)(args),
          ]),
        ) as BoundMutators<T, M>,
      );
    }
  }

  export interface ImplContext<T extends AnyRecord> {
    struct: Struct<T>;
    impl: T;
  }

  export class Impl<T extends AnyRecord> extends Type<T, ImplContext<T>> {
    public mixin(mixin: Partial<T>): Mixin<T>;
    public mixin(mixin: (base: T) => T): Mixin<T>;
    public mixin(mixin: Partial<T> | ((base: T) => T)) {
      return new Mixin(
        this.core.wrap({
          impl: this,
          mixin:
            typeof mixin === 'function'
              ? mixin
              : (base: T) => ({ ...base, ...mixin }),
        }),
      );
    }
  }

  export interface MixinContext<T extends AnyRecord> {
    impl: Impl<T>;
    mixin: (impl: T) => T;
  }

  export class Mixin<T extends AnyRecord> extends Type<T, MixinContext<T>> {
    protected __mixin: true;
  }

  export class Scope<T extends AnyRecord> extends Target<T> {
    protected __scope: true;
  }

  export abstract class Effect {
    protected __effect: true;
  }

  export class Assign<T> extends Effect {
    constructor(
      private selector: Selector<any, T>,
      private expression: Value<T>,
    ) {
      super();
    }
  }
}

// export class GoblinModify<
//   C extends GoblinContext<any>,
//   T extends GoblinType<unknown>,
// > {
//   constructor(
//     protected context: C,
//     protected selector: (context: InstanceOf<C>) => T,
//   ) {}
// }

// export class GoblinChooseOne<T extends AnyGoblinType> extends GoblinType<
//   TypeOf<T>
// > {
//   constructor(public options: T[]) {
//     super();
//   }
// }

// export class GoblinChooseMany<T extends AnyGoblinType> extends GoblinType<
//   TypeOf<T>[]
// > {
//   constructor(public options: T[], public count: number) {
//     super();
//   }
// }

export const G = new GoblinStatic();

export namespace G {
  export type TypeOf<T> = Goblin.TypeOf<T>;
  export type ImplOf<T> = Goblin.ImplOf<T>;

  export type Value<T> = Goblin.Value<T>;
}
