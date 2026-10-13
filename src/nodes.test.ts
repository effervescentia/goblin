import { describe, expect, it } from 'vitest';
import { BooleanNode } from './nodes/boolean';
import { DieNode } from './nodes/die';
import { ExpressionNode } from './nodes/expression';
import { FunctionNode } from './nodes/function';
import { ListNode } from './nodes/list';
import { NullNode } from './nodes/null';
import { NumberNode } from './nodes/number';
import { parse } from './nodes/parse';
import { RecordNode } from './nodes/record';
import { StringNode } from './nodes/string';
import { UnexpectedNode } from './nodes/unexpected';
import { Die } from './utils';

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
