import assert from 'node:assert';
import { describe, it } from 'node:test';

import { Delete, Set } from './action';
import { Engine } from './engine';

describe('Engine', () => {
  it('should set a value', () => {
    const engine = new Engine();

    engine.add(Set('foo', 'bar'));

    assert.deepStrictEqual(engine.serialize(), { foo: 'bar' });
  });

  it('should set multiple values', () => {
    const engine = new Engine();

    engine.add(Set('a', 1));
    engine.add(Set('b', 2));
    engine.add(Set('c', 3));

    assert.deepStrictEqual(engine.serialize(), { a: 1, b: 2, c: 3 });
  });

  it('should set a nested value', () => {
    const engine = new Engine();

    engine.add(Set('foo', { fizz: 'buzz' }));
    engine.add(Set('foo.fizz', 'buzz2'));

    assert.deepStrictEqual(engine.serialize(), { foo: { fizz: 'buzz2' } });
  });

  it('should delete a value', () => {
    const engine = new Engine();

    engine.add(Set('foo', 'bar'));
    engine.add(Delete('foo'));

    assert.deepStrictEqual(engine.serialize(), {});
  });
});
