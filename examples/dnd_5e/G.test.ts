import { Exact } from 'type-fest';

import { G } from './G';

const expectType = <T>() => ({
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  of: <V>(_value: G.TypeOf<V> extends Exact<T, G.TypeOf<V>> ? V : never) => {},
});

expectType<'foo' | 'bar'>().of(G.enum(['foo', 'bar']));

expectType<boolean>().of(true);
expectType<boolean>().of(G.boolean());

expectType<number>().of(100);
expectType<number>().of(G.number());

expectType<string>().of('foo');
expectType<string>().of(G.string());

expectType<boolean[]>().of(G.boolean().array());

expectType<Record<string, boolean>>().of(G.record(G.string(), G.boolean()));

expectType<{ foo: number; bar: number }>().of(
  G.record(G.enum(['foo', 'bar']), G.number()),
);

expectType<{ foo: number; bar: string }>().of(
  G.object({
    foo: G.number(),
    bar: G.string(),
  }),
);

expectType<{ foo: number; bar: string }>().of(
  G.struct({
    foo: G.number(),
    bar: G.string(),
  }),
);

expectType<{ foo: number; bar: string }>().of(
  G.scope({
    foo: G.number(),
    bar: G.string(),
  }),
);

expectType<Array<{ foo: number }>>().of(G.object({ foo: G.number() }).array());
