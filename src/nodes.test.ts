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
import { debug, print } from './nodes/serialize';
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
    expect(parse('$.utils.f(1)')).toBeInstanceOf(ExpressionNode);
    expect(parse('10 + #.x')).toBeInstanceOf(ExpressionNode);
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
    // A record body is a definition; a list is neither.
    expect(FunctionNode.match('shield()', { armor_class: 2 }, record)).toBeInstanceOf(FunctionNode);
    expect(FunctionNode.match('shield()', [1, 2], record)).toBeNull();
  });
});

describe('FunctionNode record bodies', () => {
  it('binds arguments into the copy it hands back', () => {
    const record = {
      'entry(ability)': {
        ':doc': 'ability text is prose, left alone',
        ':label': '{ability} score',
        bought: { ':param': true },
        base: '.bought + $lib.list.count(@.improvements, ability)',
      },
    };
    const fn = FunctionNode.match('entry(ability)', record['entry(ability)'], record);
    const call = fn?.evaluate({ settle: <T>(tree: T) => tree } as never, {
      doc: {},
      actor: {},
      app: {},
      current: record,
    }) as (...args: unknown[]) => Record<string, unknown>;

    const strength = call('strength');
    const wisdom = call('wisdom');
    expect(strength.base).toBe('.bought + $lib.list.count(@.improvements, "strength")');
    expect(wisdom.base).toBe('.bought + $lib.list.count(@.improvements, "wisdom")');
    // Prose keeps the bare word; `{param}` is how a parameter reaches it.
    expect(strength[':doc']).toBe('ability text is prose, left alone');
    expect(strength[':label']).toBe('strength score');
    // Separate copies, so a value filled in one never shows up in the other.
    expect(strength.bought).not.toBe(wisdom.bought);
  });
});

describe('debug', () => {
  it('delegates each kind to its node', () => {
    expect(debug(new Die(2, 6, '2d6'))).toBe('2d6');
    expect(new DieNode(new Die(1, 20, 'd20')).debug()).toBe('d20');
    expect(new ListNode([1, 2]).debug((v) => Number(v) * 2)).toEqual([2, 4]);
    expect(new RecordNode({ a: 1 }).debug((v) => Number(v) * 2)).toEqual({ a: 2 });
  });

  it('prints tagged functions as descriptors, natives as `[fn name()]`', () => {
    const tagged = FunctionNode.tag(() => 1, { name: 'f', params: ['x'], source: ' .x ', deps: ['.x'] });
    expect(FunctionNode.debug(tagged)).toEqual({
      ':type': 'function',
      ':params': ['x'],
      ':source': '.x',
      ':deps': ['.x'],
    });
    expect(FunctionNode.debug(function floor() {})).toBe('[fn floor()]');
    expect(FunctionNode.debug(() => 1)).toBe('[fn anonymous()]');
  });

  it('recurses through containers and passes scalars through', () => {
    expect(debug({ hp: [new Die(1, 8, 'd8'), 3], name: 'Aria', ok: null })).toEqual({
      hp: ['d8', 3],
      name: 'Aria',
      ok: null,
    });
  });

  it('lets each node produce its plain form without metadata', () => {
    expect(
      print({
        ':doc': 'sheet',
        name: 'Aria',
        level: { ':param': true, ':value': 3 },
        hidden: { _work: 1 },
      }),
    ).toEqual({ name: 'Aria', level: 3, hidden: null });
  });
});
