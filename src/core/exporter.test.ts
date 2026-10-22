import { describe, expect, it } from 'vitest';
import { type InputEvent, invoke, override, parameter } from '@/inputs';
import { print } from '@/nodes/serialize';
import { GoblinEngine } from './engine';
import { exportActor, locateActor } from './exporter';

// A hero whose mixin brings in a param of its own (`perks.perk`), as a class does.
const party = () => {
  const engine = new GoblinEngine('.');
  const docs: Record<string, unknown> = {
    'boon.yaml': {
      '@': 'Hero',
      '@.speed': 40,
      '+@.gold': 5,
      '@.perks': { '+perk': { ':param': true, ':type': 'string' } },
    },
    'hero.yaml': {
      $actor: 'Hero',
      name: { ':param': true, ':type': 'string' },
      speed: 30,
      gold: 1,
      hp: 10,
      bonus: 0,
      luck: '1d6 + #.bonus',
      perks: {},
      'heal(n)': '@.hp = @.hp + n',
      boon: "$mixin('boon.yaml')",
    },
    'party.yaml': { party: { scout: "$tmpl('hero.yaml')", guide: "$tmpl('hero.yaml', 'bree')" } },
  };
  for (const [file, doc] of Object.entries(docs)) engine.register(file, doc);
  return engine;
};

const chosen = [
  parameter('party.scout.name', 'Sam'),
  parameter('party.scout.perks.perk', 'keen'),
  parameter('bree.name', 'Bree'),
  parameter('bree.perks.perk', 'brave'),
];

const imported = (sets: Record<string, unknown>, version = 2): InputEvent => ({
  version,
  type: 'import',
  path: 'bree',
  value: {
    application: 'sha256:app',
    events: Object.entries(sets).map(([path, value]) => ({ type: 'set', path, value })),
  },
});

const partyOf = (data: unknown) => (print(data) as { party: Record<string, Record<string, unknown>> }).party;
const guideOf = (state: unknown) => partyOf((state as { data: unknown }).data).guide;

const actorAt = (engine: GoblinEngine, root: unknown, id: string) => {
  const at = locateActor(engine, root, id);
  if (at === undefined) throw new Error(`no actor ${id}`);
  return at;
};

describe('import events', () => {
  it('fill the params a set lands on, mixin-made ones too, and override the rest', () => {
    const state = party().resolve('party.yaml', [
      ...chosen,
      imported({ name: 'Ivy', 'perks.perk': 'lucky', hp: 3, luck: 6 }),
    ]);
    expect(guideOf(state)).toMatchObject({ name: 'Ivy', perks: { perk: 'lucky' }, hp: 3, luck: 6, speed: 40 });
  });

  it('answer every param of the actor on their own, and give way to later inputs', () => {
    const sets = imported({ name: 'Ivy', 'perks.perk': 'lucky', hp: 3 });
    const scout = chosen.slice(0, 2);
    expect(guideOf(party().resolve('party.yaml', [...scout, sets]))).toMatchObject({ name: 'Ivy', hp: 3 });
    const later = [...scout, sets, override('bree.hp', 5, 3), parameter('bree.name', 'Bo', 3)];
    expect(guideOf(party().resolve('party.yaml', later))).toMatchObject({ name: 'Bo', hp: 5 });
  });
});

describe('exportActor', () => {
  it('collapses params, sets, imports, invoke writes and rolls to one set per node, in path order', () => {
    const engine = party();
    const events = [
      ...chosen,
      override('party.scout.gold', 99),
      imported({ speed: 25 }),
      invoke('party.scout.heal', [2], 3),
      invoke('party.scout.heal', [1], 4),
    ];
    const root = engine.docs.get('party.yaml');
    const state = engine.resolve('party.yaml', events) as { data: unknown };
    const scout = actorAt(engine, root, 'party.scout');
    expect(scout).toEqual({ path: ['party', 'scout'], namespace: undefined });
    const luck = partyOf(state.data).scout?.luck;
    expect(exportActor(engine, root, state.data, events, scout)).toEqual([
      { type: 'set', path: 'gold', value: 99 },
      { type: 'set', path: 'hp', value: 13 },
      { type: 'set', path: 'luck', value: luck },
      { type: 'set', path: 'name', value: 'Sam' },
      { type: 'set', path: 'perks.perk', value: 'keen' },
    ]);
    const guide = actorAt(engine, root, 'bree');
    expect(exportActor(engine, root, state.data, events, guide).map(({ path }) => path)).toEqual([
      'luck',
      'name',
      'perks.perk',
      'speed',
    ]);
  });

  it('finds an actor by namespace or tree path, and nothing else', () => {
    const engine = party();
    const root = engine.docs.get('party.yaml');
    engine.resolve('party.yaml', chosen);
    expect(locateActor(engine, root, 'bree')).toEqual({ path: ['party', 'guide'], namespace: 'bree' });
    expect(locateActor(engine, root, 'party.guide')).toEqual({ path: ['party', 'guide'], namespace: 'bree' });
    expect(locateActor(engine, root, 'party')).toBeUndefined();
    expect(locateActor(engine, root, 'nobody')).toBeUndefined();
  });
});
