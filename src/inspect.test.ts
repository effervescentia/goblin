import { describe, expect, it } from 'vitest';
import { GoblinEngine } from './engine';
import { inspect } from './inspect';

function resolved() {
  const engine = new GoblinEngine('.');
  engine.register('actor.yaml', {
    name: { ':label': 'Name', ':param': true, ':type': 'string' },
    stats: { base: 10, bonus: '.base + 2', _hidden: 1 },
    resources: { surge: { current: 0, max: 2, recover: 'short' } },
    armor: '#.stats.bonus + 1',
    'rest()': "@.resources.{.recover == 'short'}.current = .max",
  });
  engine.register('patch.yaml', { '@.stats.base': 12 });
  const actor = engine.evalExpr("$tmpl('actor.yaml')", { doc: {}, actor: {}, app: engine.appRoot, current: {} });
  engine.apply(actor, 'patch.yaml');
  const state = engine.resolveRaw(actor, { name: 'Aria' });
  if (!('data' in state)) throw new Error('expected data');
  return Object.fromEntries(inspect(actor, state.data).map((node) => [node.path, node]));
}

describe('inspect', () => {
  it('lists every field in document order with its kind and value', () => {
    const nodes = resolved();
    expect(Object.keys(nodes)).toEqual([
      '',
      'name',
      'stats',
      'stats.base',
      'stats.bonus',
      'stats._hidden',
      'resources',
      'resources.surge',
      'resources.surge.current',
      'resources.surge.max',
      'resources.surge.recover',
      'armor',
      'rest',
    ]);
    expect(nodes.name).toMatchObject({ kind: 'param', value: 'Aria', label: 'Name', param: { ':type': 'string' } });
    expect(nodes.stats).toMatchObject({ kind: 'record', children: ['base', 'bonus', '_hidden'] });
    expect(nodes['stats._hidden']?.private).toBe(true);
  });

  it('resolves what each expression reads to absolute paths', () => {
    const nodes = resolved();
    expect(nodes['stats.bonus']).toMatchObject({
      kind: 'expression',
      expression: '.base + 2',
      value: 14,
      reads: ['stats.base'],
    });
    expect(nodes.armor?.reads).toEqual(['stats.bonus']);
    // On the right of a wildcard assignment, `.` is each match.
    expect(nodes.rest).toMatchObject({
      kind: 'function',
      reads: ["resources.{.recover == 'short'}.current", "resources.{.recover == 'short'}.max"],
    });
  });

  it('carries the events behind a patched field', () => {
    const nodes = resolved();
    expect(nodes['stats.base']).toMatchObject({
      value: 12,
      events: [
        { ':source': 'actor.yaml', ':set': 10 },
        { ':source': 'patch.yaml', ':set': 12 },
      ],
    });
    expect(nodes['stats.bonus']?.events).toBeUndefined();
  });
});
