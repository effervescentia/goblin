import { describe, expect, it } from 'vitest';
import { BooleanNode } from './nodes/boolean';
import { Die, DieNode } from './nodes/die';
import { ExpressionNode } from './nodes/expression';
import { FunctionNode } from './nodes/function';
import { ListNode } from './nodes/list';
import { NullNode } from './nodes/null';
import { NumberNode } from './nodes/number';
import { parse } from './nodes/parse';
import { RecordNode } from './nodes/record';
import { serialize } from './nodes/serialize';
import { StringNode } from './nodes/string';
import { UnexpectedNode } from './nodes/unexpected';

describe('parse', () => {
  it('classifies scalars', () => {
    expect(parse(null)).toBeInstanceOf(NullNode);
    expect(parse(undefined)).toBeInstanceOf(NullNode);
    expect(parse(true)).toBeInstanceOf(BooleanNode);
    expect(parse(3)).toBeInstanceOf(NumberNode);
    expect(parse('Fighter')).toBeInstanceOf(StringNode);
  });

  it('classifies dice, expressions, and provided Dice', () => {
    expect(parse('d6')).toBeInstanceOf(DieNode);
    expect(parse('2d6')).toBeInstanceOf(DieNode);
    expect(parse(new Die(1, 6, '1d6'))).toBeInstanceOf(DieNode);
    expect(parse('#.utils.f(1)')).toBeInstanceOf(ExpressionNode);
    expect(parse('10 + $.x')).toBeInstanceOf(ExpressionNode);
  });

  it('classifies collections and anything else', () => {
    expect(parse([1, 'a'])).toBeInstanceOf(ListNode);
    expect(parse({ a: 1 })).toBeInstanceOf(RecordNode);
    expect(parse(Symbol('?'))).toBeInstanceOf(UnexpectedNode);
  });
});

describe('FunctionNode', () => {
  it('matches definition keys and parses signatures', () => {
    const record = { 'ability_modifier(x)': 'x' };
    const fn = FunctionNode.match('ability_modifier(x)', 'x', record);
    expect(fn?.name).toBe('ability_modifier');
    expect(fn?.params).toEqual(['x']);
    expect(FunctionNode.match('plain', 'x', record)).toBeNull();
    expect(FunctionNode.match('roll()', 42, record)).toBeNull();
  });
});

describe('serialize', () => {
  it('delegates each kind to its node', () => {
    expect(serialize(new Die(2, 6, '2d6'))).toBe('2d6');
    expect(DieNode.serialize(new Die(1, 20, 'd20'))).toBe('d20');
    expect(ListNode.serialize([1, 2], (v) => Number(v) * 2)).toEqual([2, 4]);
    expect(RecordNode.serialize({ a: 1 }, (v) => Number(v) * 2)).toEqual({ a: 2 });
  });

  it('prints tagged functions as descriptors, natives as `[fn name()]`', () => {
    const tagged = FunctionNode.tag(() => 1, { name: 'f', params: ['x'], source: ' .x ', deps: ['.x'] });
    expect(FunctionNode.serialize(tagged)).toEqual({
      ':type': 'function',
      ':params': ['x'],
      ':source': '.x',
      ':deps': ['.x'],
    });
    expect(FunctionNode.serialize(function floor() {})).toBe('[fn floor()]');
    expect(FunctionNode.serialize(() => 1)).toBe('[fn anonymous()]');
  });

  it('recurses through containers and passes scalars through', () => {
    expect(serialize({ hp: [new Die(1, 8, 'd8'), 3], name: 'Aria', ok: null })).toEqual({
      hp: ['d8', 3],
      name: 'Aria',
      ok: null,
    });
  });
});
