import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { type InputEvent, invoke, override, parameter, type StateEvent } from '@/inputs';
import { Die, DieNode } from '@/nodes/die';
import { ExpressionNode } from '@/nodes/expression';
import { FunctionNode } from '@/nodes/function';
import { RecordNode } from '@/nodes/record';
import { debug, print } from '@/nodes/serialize';
import { type EvalRoots, parseRef } from '@/utils';
import { GoblinEngine } from './engine';

function testEngine() {
  const engine = new GoblinEngine('.');
  const doc = {
    utils: {
      'ability_modifier(x)': '$lib.math.floor((x - 10) / 2)',
    },
    abilities: {
      strength: { base: 15, modifier: '$.utils.ability_modifier(.base)' },
      dexterity: { base: 14, modifier: '$.utils.ability_modifier(.base)' },
      wisdom: { base: 12, modifier: '$.utils.ability_modifier(.base)' },
    },
    armor_class: '10 + $.abilities.dexterity.modifier',
    initiative: {
      base: '$.abilities.dexterity.modifier',
      'roll()': '1d20 + .base',
    },
    hit_die: 'd6',
    hit_points: {
      '!validate': ['.current >= 0', '.current <= .max'],
      current: 3,
      max: 5,
    },
    rest: {
      'short()': '$.hit_points.current = $lib.math.min($.hit_points.current + $.hit_die, $.hit_points.max)',
    },
  };
  engine.docs.set('main.yaml', doc);
  // Mirror loadFile(): top-level tables are visible under `#`.
  Object.assign(engine.appRoot, structuredClone(doc));
  const scope: EvalRoots = { doc, actor: doc, app: engine.appRoot, current: doc };
  return { engine, doc, scope };
}

describe('parseRef', () => {
  it('splits sigil and segments', () => {
    expect(parseRef('$.utils.ability_modifier')).toEqual({ root: '$', path: ['utils', 'ability_modifier'] });
    expect(parseRef('#.abilities.dexterity')).toEqual({ root: '#', path: ['abilities', 'dexterity'] });
    expect(parseRef('@.features')).toEqual({ root: '@', path: ['features'] });
    expect(parseRef('.base')).toEqual({ root: '.', path: ['base'] });
  });

  it('handles bare sigils and missing dots', () => {
    expect(parseRef('$')).toEqual({ root: '$', path: [] });
    expect(parseRef('@')).toEqual({ root: '@', path: [] });
    expect(parseRef('#math.min')).toEqual({ root: '#', path: ['math', 'min'] });
  });
});

describe('dice', () => {
  it('detects die literals', () => {
    expect(DieNode.isLiteral('d6')).toBe(true);
    expect(DieNode.isLiteral('2d6')).toBe(true);
    expect(DieNode.isLiteral('bonus_action')).toBe(false);
    expect(DieNode.isLiteral('1d20 + .base')).toBe(false);
  });

  it('parses dice and preserves the label', () => {
    expect(DieNode.parse('1d6')).toEqual(new Die(1, 6, '1d6'));
    expect(String(DieNode.parse('d20'))).toBe('d20');
    expect(DieNode.parse('nope')).toBeNull();
  });

  it('rolls within range', () => {
    const die = new Die(2, 6);
    for (let i = 0; i < 50; i++) {
      const roll = die.roll();
      expect(roll).toBeGreaterThanOrEqual(2);
      expect(roll).toBeLessThanOrEqual(12);
    }
  });

  it('returns Die specs standalone, rolls inline dice in expressions', () => {
    const { engine, scope } = testEngine();
    expect(engine.evalExpr('1d20', scope)).toBeInstanceOf(Die);
    const roll = engine.evalExpr('1d20 + 0', scope);
    expect(roll).toBeGreaterThanOrEqual(1);
    expect(roll).toBeLessThanOrEqual(20);
  });

  it('rolls an expression field once per evaluation, however it is reached', () => {
    const engine = new GoblinEngine('.');
    const doc = { score: { roll: '1d1000000 + 0', copy: '.roll', again: '#.score.roll' } };
    engine.docs.set('roll.yaml', doc);
    const out = engine.evaluateDoc('roll.yaml') as { score: { roll: number; copy: number; again: number } };
    expect(out.score.copy).toBe(out.score.roll);
    expect(out.score.again).toBe(out.score.roll);
  });

  it('rolls each list item once, however it is reached', () => {
    const engine = new GoblinEngine('.');
    const doc = { rolls: ['1d1000000 + 0', '1d1000000 + 0'], first: '#.rolls[0]', last: '#.rolls[-1]' };
    engine.docs.set('rolls.yaml', doc);
    const out = engine.evaluateDoc('rolls.yaml') as { rolls: number[]; first: number; last: number };
    expect(out.first).toBe(out.rolls[0]);
    expect(out.last).toBe(out.rolls[1]);
  });

  it('keeps the highest dice with $lib.dice.keep_highest', () => {
    const { engine, scope } = testEngine();
    for (let i = 0; i < 50; i++) {
      const roll = engine.evalExpr('$lib.dice.keep_highest(4, 6, 3)', scope) as number;
      expect(roll).toBeGreaterThanOrEqual(3);
      expect(roll).toBeLessThanOrEqual(18);
    }
    // Keeping one of many d1s is always 1; keeping every die is the plain sum.
    expect(engine.evalExpr('$lib.dice.keep_highest(5, 1, 1)', scope)).toBe(1);
    expect(engine.evalExpr('$lib.dice.keep_highest(3, 1, 3)', scope)).toBe(3);
  });
});

describe('expressions', () => {
  it('detects expression strings', () => {
    expect(ExpressionNode.matches('$.utils.ability_modifier(.base)')).toBe(true);
    expect(ExpressionNode.matches('10 + #.abilities.dexterity.modifier')).toBe(true);
    expect(ExpressionNode.matches('bonus_action')).toBe(false);
    expect(ExpressionNode.matches('Player')).toBe(false);
  });

  it('evaluates arithmetic and references', () => {
    const { engine, scope } = testEngine();
    expect(engine.evalExpr('10 + $.abilities.dexterity.modifier', scope)).toBe(12);
    expect(engine.evalExpr('$.utils.ability_modifier(15)', scope)).toBe(2);
  });

  it('resolves `.` against the current node', () => {
    const { engine, doc, scope } = testEngine();
    const strength = (doc.abilities as Record<string, unknown>).strength;
    expect(engine.evalExpr('.base', { ...scope, current: strength })).toBe(15);
  });

  it('resolves the $lib standard library', () => {
    const { engine, scope } = testEngine();
    expect(engine.evalExpr('$lib.math.min(3, 5)', scope)).toBe(3);
    expect(engine.evalExpr('$lib.math.max(3, 5)', scope)).toBe(5);
    expect(engine.evalExpr('$lib.math.floor(2.9)', scope)).toBe(2);
  });

  it('does not resolve `#math` / `#.math` — the stdlib is `$lib` only', () => {
    const { engine, scope } = testEngine();
    expect(() => engine.evalExpr('#math.min(3, 5)', scope)).toThrow('unresolvable reference: #.math.min');
    expect(() => engine.evalExpr('#.math.min(3, 5)', scope)).toThrow('unresolvable reference: #.math.min');
    expect(() => engine.evalExpr('$.math.min(3, 5)', scope)).toThrow('unresolvable reference: $.math.min');
    // No bare `math` binding leaks into compiled expressions either.
    expect(() => engine.evalExpr('math.min(3, 5)', scope)).toThrow();
  });

  it('never falls back from a missing `.` path to the app root', () => {
    const engine = new GoblinEngine('.');
    engine.appRoot.abilities = { dexterity: { modifier: 2 } };
    const initiative = { base: '.abilities.dexterity.modifier' };
    const doc = { initiative };
    const scope: EvalRoots = { doc, actor: doc, app: engine.appRoot, current: initiative };
    expect(() => engine.evalExpr(initiative.base, scope)).toThrow(
      'unresolvable reference: .abilities.dexterity.modifier',
    );
  });

  it('never falls back from a missing `$` path to the document', () => {
    const engine = new GoblinEngine('.');
    const doc = { only_here: 1 };
    const scope: EvalRoots = { doc, actor: doc, app: engine.appRoot, current: doc };
    expect(engine.evalExpr('#.only_here', scope)).toBe(1);
    expect(() => engine.evalExpr('$.only_here', scope)).toThrow('unresolvable reference: $.only_here');
  });

  it('never falls back from a missing `#` or `@` path to the app root', () => {
    const engine = new GoblinEngine('.');
    engine.appRoot.shared = 1;
    const doc = {};
    const scope: EvalRoots = { doc, actor: doc, app: engine.appRoot, current: doc };
    expect(engine.evalExpr('$.shared', scope)).toBe(1);
    expect(() => engine.evalExpr('#.shared', scope)).toThrow('unresolvable reference: #.shared');
    expect(() => engine.evalExpr('@.shared', scope)).toThrow('unresolvable reference: @.shared');
  });

  it('merges yaml helpers into $lib, natives winning on name clashes', () => {
    const engine = new GoblinEngine('.');
    engine.mergeLib({ 'double(x)': 'x * 2', math: { 'floor(x)': '0', 'sign(x)': '1' } });
    const scope = { doc: {}, actor: {}, app: engine.appRoot, current: {}, path: [] };
    expect(engine.evalExpr('$lib.double(21)', scope)).toBe(42);
    expect(engine.evalExpr('$lib.math.sign(2.9)', scope)).toBe(1); // yaml extends the namespace
    expect(engine.evalExpr('$lib.math.floor(2.9)', scope)).toBe(2); // native beats the yaml floor
  });

  it('throws on unresolvable references', () => {
    const { engine, scope } = testEngine();
    expect(() => engine.evalExpr('$.missing.thing', scope)).toThrow('unresolvable reference');
  });

  it('detects circular references', () => {
    const engine = new GoblinEngine('.');
    const doc = { a: '.b', b: '.a' };
    const scope: EvalRoots = { doc, actor: doc, app: engine.appRoot, current: doc };
    expect(() => engine.evaluate(doc, scope)).toThrow('circular reference');
  });
});

describe('evaluate', () => {
  it('resolves ability modifiers and armor class', () => {
    const { engine } = testEngine();
    const out = engine.evaluateDoc('main.yaml') as Record<string, any>;
    const abilities = out.abilities as Record<string, { base: number; modifier: number }>;
    expect(abilities.strength?.modifier).toBe(2);
    expect(abilities.dexterity?.modifier).toBe(2);
    expect(out.armor_class).toBe(12);
    expect((out.initiative as { base: number }).base).toBe(2);
  });

  it('turns function keys into callables', () => {
    const { engine } = testEngine();
    const out = engine.evaluateDoc('main.yaml') as Record<string, any>;
    expect(typeof out.utils.ability_modifier).toBe('function');
    expect(out.utils.ability_modifier(8)).toBe(-1);
    const roll = (out.initiative as { roll: () => number }).roll();
    expect(roll).toBeGreaterThanOrEqual(-3);
    expect(roll).toBeLessThanOrEqual(22);
  });

  it('keeps dice as Die instances and metadata raw', () => {
    const { engine } = testEngine();
    const out = engine.evaluateDoc('main.yaml') as Record<string, any>;
    expect(out.hit_die).toBeInstanceOf(Die);
    expect(String(out.hit_die)).toBe('d6');
  });

  it('runs multi-statement bodies with assignment', () => {
    const { engine } = testEngine();
    const out = engine.evaluateDoc('main.yaml') as Record<string, any>;
    (out.rest as { short: () => unknown }).short();
    const appView = engine.evaluate(engine.appRoot, {
      doc: engine.docs.get('main.yaml'),
      actor: engine.docs.get('main.yaml'),
      app: engine.appRoot,
      current: engine.appRoot,
    }) as Record<string, any>;
    const current = (appView.hit_points as Record<string, unknown>).current;
    expect(fieldValue(current)).toBeGreaterThanOrEqual(3);
    expect(fieldValue(current)).toBeLessThanOrEqual(5);
    // The assignment files a `:set` over the prior value, like a patch write.
    expect((current as { ':events': unknown[] })[':events']).toEqual([
      { ':set': 3 },
      { ':source': 'main.yaml', ':set': fieldValue(current) },
    ]);
  });
});

/** Read a `{ :value, :events }` field (what a patch wrote) or a bare value. */
function fieldValue(node: unknown): unknown {
  return node && typeof node === 'object' && ':value' in node ? (node as Record<string, unknown>)[':value'] : node;
}

describe('indexing', () => {
  const scopeOf = (doc: Record<string, unknown>): EvalRoots => ({ doc, actor: doc, app: {}, current: doc });
  const doc = {
    ranked: ['gold', 'silver', 'bronze'],
    grid: [
      [1, 2],
      [3, 4],
    ],
    place: 2,
    name: 'x',
  };

  it('picks items from 0, negative from the end, null past either end', () => {
    const engine = new GoblinEngine('.');
    expect(engine.evalExpr('#.ranked[0]', scopeOf(doc))).toBe('gold');
    expect(engine.evalExpr('#.ranked[-1]', scopeOf(doc))).toBe('bronze');
    expect(engine.evalExpr('#.ranked[#.place - 1]', scopeOf(doc))).toBe('silver');
    expect(engine.evalExpr('#.ranked[3]', scopeOf(doc))).toBeNull();
    expect(engine.evalExpr('#.ranked[-4]', scopeOf(doc))).toBeNull();
  });

  it('chains, nests, and leaves list literals alone', () => {
    const engine = new GoblinEngine('.');
    expect(engine.evalExpr('#.grid[1][0]', scopeOf(doc))).toBe(3);
    expect(engine.evalExpr('#.grid[#.grid[0][0]][1]', scopeOf(doc))).toBe(4);
    expect(engine.evalExpr('$lib.set.subset([1, 2], [2, 1, 3])', scopeOf(doc))).toBe(1);
    expect(engine.evalExpr('[#.place, 5][1]', scopeOf(doc))).toBe(5);
  });

  it('refuses non-lists and non-integer indexes', () => {
    const engine = new GoblinEngine('.');
    expect(() => engine.evalExpr('#.name[0]', scopeOf(doc))).toThrow('cannot index string: not a list or record');
    expect(() => engine.evalExpr('#.ranked[0.5]', scopeOf(doc))).toThrow('list index must be an integer, got 0.5');
  });
});

describe('wildcards', () => {
  const pools = () => ({
    resources: {
      ':doc': 'uses',
      surge: { current: 0, max: 2, recover: 'short' },
      indomitable: { current: 0, max: 3, recover: 'long' },
      'reset()': '1',
    },
    flags: [{ on: true }, { on: false }, {}],
  });

  it('reads every match as a list, skipping metadata, functions and misses', () => {
    const engine = new GoblinEngine('.');
    const doc = pools();
    const scope: EvalRoots = { doc, actor: doc, app: {}, current: doc };
    expect(engine.evalExpr('#.resources.*.max', scope)).toEqual([2, 3]);
    expect(engine.evalExpr('#.flags.*.on', scope)).toEqual([true, false]);
    expect(engine.evalExpr('$lib.list.size(#.resources.*.max)', scope)).toBe(2);
  });

  it('filters matches with a predicate, skipping children it cannot read', () => {
    const engine = new GoblinEngine('.');
    const doc = pools();
    const scope: EvalRoots = { doc, actor: doc, app: {}, current: doc };
    expect(engine.evalExpr("#.resources.{.recover == 'short'}.max", scope)).toEqual([2]);
    expect(engine.evalExpr('#.resources.{.max > 1 && .max < 3}.max', scope)).toEqual([2]);
    expect(engine.evalExpr('#.resources.{.recover == "long"}.max', scope)).toEqual([3]);
    // The third flag has no `on`: it does not match rather than throwing.
    expect(engine.evalExpr('#.flags.{.on}.on', scope)).toEqual([true]);
  });

  it('assigns each match, with `.` bound to the record being written', () => {
    const engine = new GoblinEngine('.');
    const doc = pools();
    const scope: EvalRoots = { doc, actor: doc, app: {}, current: doc };
    engine.evalExpr("#.resources.{.recover == 'short'}.current = .max", scope);
    expect(doc.resources.surge.current).toBe(2);
    expect(doc.resources.indomitable.current).toBe(0);
    engine.evalExpr('#.resources.*.current = .max', scope);
    expect(doc.resources.indomitable.current).toBe(3);
  });

  it('files `+=` as `:add` and `-=` as `:subtract`, after the prior value', () => {
    const engine = new GoblinEngine('.');
    engine.register('hp.yaml', {
      hp: { current: 5, max: 10 },
      'heal()': '@.hp.current += 1d1 + 2',
      'hurt()': '@.hp.current -= 4',
    });
    const doc = engine.docs.get('hp.yaml') as { hp: { current: number } };
    const scope: EvalRoots = { doc, actor: doc, app: {}, current: doc, source: 'hp.yaml' };
    (engine.evaluateDoc('hp.yaml') as { heal: () => void }).heal();
    (engine.evaluate(doc, scope) as { hurt: () => void }).hurt();
    expect(doc.hp.current).toBe(4);
    const out = engine.evaluateDoc('hp.yaml') as { hp: { current: unknown } };
    expect(out.hp.current).toEqual({
      ':value': 4,
      ':events': [
        { ':source': 'hp.yaml', ':set': 5 },
        { ':source': 'hp.yaml', ':add': 3 },
        { ':source': 'hp.yaml', ':subtract': 4 },
      ],
    });
  });

  it('adds and takes with `+=` / `-=`, per match on a wildcard', () => {
    const engine = new GoblinEngine('.');
    const doc = pools();
    const scope: EvalRoots = { doc, actor: doc, app: {}, current: doc };
    engine.evalExpr('#.resources.surge.current += 2 * 3', scope);
    expect(doc.resources.surge.current).toBe(6);
    engine.evalExpr('#.resources.surge.current -= 1 + 1', scope);
    expect(doc.resources.surge.current).toBe(4);
    engine.evalExpr('#.resources.*.current += .max', scope);
    expect(doc.resources.surge.current).toBe(6);
    expect(doc.resources.indomitable.current).toBe(3);
    engine.evalExpr("#.resources.{.recover == 'long'}.current -= 1", scope);
    expect(doc.resources.indomitable.current).toBe(2);
  });

  it('lists wildcard refs among function deps', () => {
    expect(FunctionNode.detectDeps('@.resources.*.current = .max')).toEqual(['@.resources.*.current', '.max']);
    expect(FunctionNode.detectDeps("@.resources.{.recover == 'short'}.current = .max")).toEqual([
      "@.resources.{.recover == 'short'}.current",
      '.max',
    ]);
  });

  it("skips another document's `_` fields", () => {
    const engine = new GoblinEngine('.');
    engine.register('a.yaml', { stats: { _hidden: 1, open: 2 } });
    engine.register('b.yaml', { all: '$.stats.*' });
    const out = engine.evaluateDoc('b.yaml') as { all: unknown };
    expect(out.all).toEqual([2]);
  });
});

describe('event locations', () => {
  // Documents registered with their text cite the line and column of the key
  // behind each write; `yaml` parses here so the test stays runtime-agnostic.
  const load = (engine: GoblinEngine, file: string, text: string) => engine.register(file, parseYaml(text), text);

  it('cites the patch key, the origin key and the function that assigned', () => {
    const engine = new GoblinEngine('.');
    load(engine, 'actor.yaml', ['hp:', '  current: 3', '  max: 9', "'heal()': '@.hp.current += 2'"].join('\n'));
    load(engine, 'patch.yaml', ['note: unrelated', "'@.hp':", '  max: 12'].join('\n'));
    const actor = engine.evalExpr("$tmpl('actor.yaml')", { doc: {}, actor: {}, app: engine.appRoot, current: {} });
    engine.apply(actor, 'patch.yaml');
    const scope: EvalRoots = { doc: actor, actor, app: engine.appRoot, current: actor };
    (engine.evaluate(actor, scope) as { heal: () => void }).heal();
    const out = engine.evaluate(actor, scope) as { hp: { current: unknown; max: unknown } };
    expect(out.hp.max).toEqual({
      ':value': 12,
      ':events': [
        { ':source': 'actor.yaml', ':line': 3, ':column': 3, ':set': 9 },
        { ':source': 'patch.yaml', ':line': 3, ':column': 3, ':set': 12 },
      ],
    });
    expect(out.hp.current).toEqual({
      ':value': 5,
      ':events': [
        { ':source': 'actor.yaml', ':line': 2, ':column': 3, ':set': 3 },
        { ':source': 'actor.yaml', ':line': 4, ':column': 1, ':add': 2 },
      ],
    });
  });

  it('leaves positions out when a document was registered without its text', () => {
    const engine = new GoblinEngine('.');
    engine.register('actor.yaml', { hp: 1 });
    engine.register('patch.yaml', { '@.hp': 2 });
    const actor = engine.evalExpr("$tmpl('actor.yaml')", { doc: {}, actor: {}, app: engine.appRoot, current: {} });
    engine.apply(actor, 'patch.yaml');
    const out = engine.evaluate(actor, { doc: actor, actor, app: engine.appRoot, current: actor }) as { hp: unknown };
    expect(out.hp).toEqual({
      ':value': 2,
      ':events': [
        { ':source': 'actor.yaml', ':set': 1 },
        { ':source': 'patch.yaml', ':set': 2 },
      ],
    });
  });
});

describe('mixins', () => {
  const boon = { '@': 'Hero', '@.speed': 40, '+@.gold': 5 };
  const engineWith = (docs: Record<string, unknown>) => {
    const engine = new GoblinEngine('.');
    for (const [file, doc] of Object.entries(docs)) engine.register(file, doc);
    return engine;
  };

  it('merges into the actor document that calls it, consuming the key', () => {
    const engine = engineWith({
      'boon.yaml': boon,
      'hero.yaml': { $actor: 'Hero', speed: 30, gold: 1, boon: "$mixin('boon.yaml')" },
    });
    const state = engine.resolve('hero.yaml') as { data: Record<string, unknown> };
    expect(state.data.boon).toBeUndefined();
    expect(state.data.speed).toEqual({
      ':value': 40,
      ':events': [
        { ':source': 'hero.yaml', ':set': 30 },
        { ':source': 'boon.yaml', ':set': 40 },
      ],
    });
    expect(fieldValue(state.data.gold)).toBe(6);
  });

  it('drops a record in an actor document that only held mixin calls', () => {
    const engine = engineWith({
      'boon.yaml': boon,
      'hero.yaml': { $actor: 'Hero', speed: 30, gold: 1, gifts: { first: "$mixin('boon.yaml')" } },
    });
    const state = engine.resolve('hero.yaml') as { data: Record<string, unknown> };
    expect(state.data).not.toHaveProperty('gifts');
    expect(fieldValue(state.data.speed)).toBe(40);
  });

  it('merges into the actor a patch applies to, leaving no empty record behind', () => {
    const engine = engineWith({
      'boon.yaml': boon,
      'hero.yaml': { $actor: 'Hero', speed: 30, gold: 1 },
      'class.yaml': { '@': 'Hero', '@.hp': 10, extras: { blessing: "$mixin('boon.yaml')" } },
    });
    const actor = engine.evalExpr("$tmpl('hero.yaml')", { doc: {}, actor: {}, app: engine.appRoot, current: {} });
    engine.apply(actor, 'class.yaml');
    expect(actor).toMatchObject({ speed: 40, gold: 6, hp: 10 });
    expect(actor).not.toHaveProperty('extras');
  });

  it('walks up the template chain to the nearest document declaring its actor', () => {
    const engine = engineWith({ 'boon.yaml': boon, 'kit.yaml': { blessing: "$mixin('boon.yaml')" } });
    const hero: Record<string, unknown> = { $actor: 'Hero', speed: 30, gold: 1 };
    const scope: EvalRoots = { doc: hero, actor: hero, app: engine.appRoot, current: hero };
    // `kit.yaml` declares no actor: its mixin lands on the Hero that pulled it in.
    const kit = engine.evalExpr("$tmpl('kit.yaml')", scope);
    engine.applyRaw(hero, kit);
    expect(hero).toMatchObject({ speed: 40, gold: 6 });
  });

  it('requires a mixin to name its actor and a parent document declaring it', () => {
    const untyped = engineWith({
      'loose.yaml': { '@.speed': 1 },
      'hero.yaml': { $actor: 'Hero', x: "$mixin('loose.yaml')" },
    });
    expect(() => untyped.resolve('hero.yaml')).toThrow(
      'mixin loose.yaml must name the actor it attaches to with a top-level `@`',
    );
    const stranger = engineWith({ 'boon.yaml': boon, 'pet.yaml': { $actor: 'Pet', x: "$mixin('boon.yaml')" } });
    expect(() => stranger.resolve('pet.yaml')).toThrow("$mixin('boon.yaml'): no parent document defines actor Hero");
  });
});

describe('nested actors', () => {
  const engineWith = (docs: Record<string, unknown>) => {
    const engine = new GoblinEngine('.');
    for (const [file, doc] of Object.entries(docs)) engine.register(file, doc);
    return engine;
  };
  const party = () =>
    engineWith({
      'boon.yaml': { '@': 'Hero', $if: '@.speed >= 30', '@.speed': 40, '+@.gold': 5 },
      'hero.yaml': {
        $actor: 'Hero',
        name: { ':param': true, ':type': 'string' },
        speed: 30,
        gold: 1,
        pace: '@.speed',
        boon: "$mixin('boon.yaml')",
      },
      'party.yaml': { party: { scout: "$tmpl('hero.yaml')", guide: "$tmpl('hero.yaml')" } },
    });

  it("asks for each nested actor's params by their path from the root", () => {
    const state = party().resolve('party.yaml') as { query: Array<{ path: string }> };
    expect(state.query.map((param) => param.path)).toEqual(['party.scout.name', 'party.guide.name']);
  });

  it('gives each nested actor its own `@`, mixins, params and overrides', () => {
    const inputs = [
      parameter('party.scout.name', 'Ash'),
      parameter('party.guide.name', 'Bree'),
      override('party.guide.speed', 20),
    ];
    const state = party().resolve('party.yaml', inputs) as {
      data: { party: Record<string, Record<string, unknown>> };
    };
    const { scout, guide } = state.data.party;
    expect(fieldValue(scout?.name)).toBe('Ash');
    expect(fieldValue(scout?.speed)).toBe(40);
    expect(fieldValue(scout?.gold)).toBe(6);
    expect(scout?.pace).toBe(40);
    // The override lands before the boon gates on it, so the boon holds back.
    expect(fieldValue(guide?.name)).toBe('Bree');
    expect(fieldValue(guide?.speed)).toBe(20);
    expect(fieldValue(guide?.gold)).toBe(1);
    expect(guide?.pace).toBe(20);
  });

  it("keeps a nested actor's overrides over its mixins' writes when something is invoked", () => {
    // A namespaced override only lands as expansion enters its actor, so the
    // boon's `+@.gold` writes over it until a later expansion re-applies it.
    const gold = (...extra: InputEvent[]) => {
      const engine = party();
      engine.register('party.yaml', { party: { guide: "$tmpl('hero.yaml', 'bree')" } });
      (engine.docs.get('hero.yaml') as Record<string, unknown>)['rest()'] = '@.speed = @.speed';
      const inputs = [parameter('bree.name', 'Bree'), override('bree.gold', 100), ...extra];
      const state = engine.resolve('party.yaml', inputs) as {
        data: { party: Record<string, Record<string, unknown>> };
      };
      return fieldValue(state.data.party.guide?.gold);
    };
    expect(gold()).toBe(100);
    expect(gold(invoke('party.guide.rest'))).toBe(100);
  });

  it('invokes a function inside a nested actor as that actor', () => {
    const engine = party();
    (engine.docs.get('hero.yaml') as Record<string, unknown>)['rest()'] = '@.gold = @.gold + @.speed';
    const inputs = [
      parameter('party.scout.name', 'Ash'),
      parameter('party.guide.name', 'Bree'),
      invoke('party.guide.rest'),
    ];
    const state = engine.resolve('party.yaml', inputs) as { data: { party: Record<string, Record<string, unknown>> } };
    expect(fieldValue(state.data.party.guide?.gold)).toBe(46);
    expect(fieldValue(state.data.party.scout?.gold)).toBe(6);
  });

  // Each resolve gets a fresh engine, as each CLI run does: resolving expands the raw doc in place.
  const recruiting = () => {
    const engine = party();
    (engine.docs.get('party.yaml') as Record<string, unknown>)['recruit(name)'] =
      "$.party[name] = $tmpl('hero.yaml', name)";
    // Gated on a param, so it only applies once the recruit's choices reach it.
    engine.docs.set('perk.yaml', { '@': 'Hero', $if: "@.name == 'Dorn'", '+@.gold': 100 });
    (engine.docs.get('hero.yaml') as Record<string, unknown>).perk = "$mixin('perk.yaml')";
    return engine;
  };
  const named = [parameter('party.scout.name', 'Ash'), parameter('party.guide.name', 'Bree')];

  it('writes in a new namespaced actor from an invoke, then asks for its params', () => {
    const asked = recruiting().resolve('party.yaml', [...named, invoke('recruit', ['dorn'])]) as {
      query: Array<{ path: string }>;
    };
    expect(asked.query.map((param) => param.path)).toEqual(['dorn.name']);

    const engine = recruiting();
    const recruited = [...named, invoke('recruit', ['dorn']), parameter('dorn.name', 'Dorn')];
    const state = engine.resolve('party.yaml', recruited) as {
      data: { party: Record<string, Record<string, unknown>> };
    };
    const dorn = state.data.party.dorn;
    expect(fieldValue(dorn?.name)).toBe('Dorn');
    expect(fieldValue(dorn?.speed)).toBe(40); // its mixins applied, the param-gated one too
    expect(fieldValue(dorn?.gold)).toBe(106);
    // The write logs the call that made the actor, not its whole tree.
    const call = "$tmpl('hero.yaml', 'dorn')";
    expect(dorn?.[':events']).toEqual([{ ':source': 'party.yaml', ':set': call }]);
    const writes = engine.events(engine.docs.get('party.yaml'), state.data).map((entry) => entry.event);
    expect(writes).toContainEqual(expect.objectContaining({ type: 'set', path: 'party.dorn', value: call }));
    expect(writes).toContainEqual(expect.objectContaining({ type: 'add', path: 'party.dorn.gold', value: 100 }));

    // Replayed, the recorded write declares `dorn`, so a later set reaches it.
    const written: StateEvent = { version: 1, type: 'set', path: 'party.dorn', value: call };
    const later = recruiting().resolve('party.yaml', [...recruited, written, override('dorn.gold', 9)]) as typeof state;
    expect(fieldValue(later.data.party.dorn?.gold)).toBe(9);
    expect(fieldValue(later.data.party.scout?.gold)).toBe(6); // no perk: not Dorn
  });

  it('rejects an indexed assignment key that is not one path segment', () => {
    expect(() => recruiting().resolve('party.yaml', [...named, invoke('recruit', ['a.b'])])).toThrow(
      'invalid assignment key "a.b" for $.party',
    );
  });

  it('reads into a nested actor as that actor, through any sigil', () => {
    const engine = party();
    const root = engine.docs.get('party.yaml') as Record<string, unknown>;
    Object.assign(root, {
      via_app: '$.party.scout.pace',
      via_doc: '#.party.scout.pace',
      via_actor: '@.party.scout.pace',
      via_current: '.party.scout.pace',
      scout_name: '$.party.scout.name',
    });
    const state = engine.resolve('party.yaml', [
      parameter('party.scout.name', 'Ash'),
      parameter('party.guide.name', 'Bree'),
    ]) as {
      data: Record<string, unknown>;
    };
    // `pace: '@.speed'` reads the scout, boon included, not the party root.
    expect(state.data).toMatchObject({ via_app: 40, via_doc: 40, via_actor: 40, via_current: 40, scout_name: 'Ash' });
  });

  describe('namespaces', () => {
    const named = (members: Record<string, unknown>) => {
      const engine = party();
      engine.register('party.yaml', { party: members });
      return engine;
    };

    it('asks for a namespaced actor by its namespace', () => {
      const engine = named({ scout: "$tmpl('hero.yaml')", guide: "$tmpl('hero.yaml', 'bree')" });
      const state = engine.resolve('party.yaml') as { query: Array<{ path: string }> };
      expect(state.query.map((param) => param.path)).toEqual(['party.scout.name', 'bree.name']);
      expect(engine.missingParams('party.yaml').map((param) => param.path)).toEqual(['party.scout.name', 'bree.name']);
    });

    it('takes --param and --set by namespace or by path', () => {
      for (const inputs of [
        [parameter('bree.name', 'Bree'), override('bree.speed', 20)],
        [parameter('party.guide.name', 'Bree'), override('party.guide.speed', 20)],
      ]) {
        const engine = named({ guide: "$tmpl('hero.yaml', 'bree')" });
        const state = engine.resolve('party.yaml', inputs) as {
          data: { party: Record<string, Record<string, unknown>> };
        };
        const guide = state.data.party.guide;
        expect(fieldValue(guide?.name)).toBe('Bree');
        // The override lands before the boon gates on it, either way.
        expect(fieldValue(guide?.speed)).toBe(20);
        expect(fieldValue(guide?.gold)).toBe(1);
        expect(state.data).not.toHaveProperty('bree');
      }
    });

    it('fills a namespaced param for the expressions that read it', () => {
      const engine = named({ guide: "$tmpl('hero.yaml', 'bree')" });
      (engine.docs.get('party.yaml') as Record<string, unknown>).lead = '$.party.guide.name';
      const state = engine.resolve('party.yaml', [parameter('bree.name', 'Bree')]) as { data: Record<string, unknown> };
      expect(state.data.lead).toBe('Bree');
    });

    it('throws when two actors share a namespace', () => {
      const engine = named({ scout: "$tmpl('hero.yaml', 'x')", guide: "$tmpl('hero.yaml', 'x')" });
      expect(() => engine.resolve('party.yaml')).toThrow('duplicate actor namespace x: party.scout and party.guide');
    });

    it('throws when a template used twice names the actor inside it', () => {
      const engine = party();
      engine.register('pair.yaml', { $actor: 'Pair', lead: "$tmpl('hero.yaml', 'lead')" });
      engine.register('party.yaml', { a: "$tmpl('pair.yaml')", b: "$tmpl('pair.yaml')" });
      expect(() => engine.resolve('party.yaml')).toThrow('duplicate actor namespace lead: a.lead and b.lead');
    });

    it('only names actors, with a plain identifier that no top-level key shadows', () => {
      const engine = party();
      engine.register('gear.yaml', { weight: 1 });
      engine.register('party.yaml', { gear: "$tmpl('gear.yaml', 'kit')" });
      expect(() => engine.resolve('party.yaml')).toThrow('only an actor document');
      engine.register('party.yaml', { a: "$tmpl('hero.yaml', 'not-ok')" });
      expect(() => engine.resolve('party.yaml')).toThrow("invalid actor namespace 'not-ok'");
      engine.register('party.yaml', { a: "$tmpl('hero.yaml', 'a')" });
      expect(() => engine.resolve('party.yaml')).toThrow('actor namespace a shadows a top-level key');
    });
  });

  it("never asks for the params inside a definition's body", () => {
    expect(RecordNode.collectParams({ 'pick(x)': { choice: { ':param': true } } })).toEqual([]);
  });
});

describe('private fields', () => {
  // `register` records which document wrote each node, as loadFile does.
  const engineWith = (docs: Record<string, unknown>) => {
    const engine = new GoblinEngine('.');
    for (const [file, doc] of Object.entries(docs)) engine.register(file, doc);
    return engine;
  };

  it('lets a document read its own `_` fields', () => {
    const engine = engineWith({ 'own.yaml': { _secret: 4, shown: '#._secret * 2', box: { _n: 1, m: '._n + 1' } } });
    const out = engine.evaluateDoc('own.yaml') as { shown: number; box: { m: number } };
    expect(out.shown).toBe(8);
    expect(out.box.m).toBe(2);
    // Stripped output drops them like metadata.
    expect(print(out)).toEqual({ shown: 8, box: { m: 2 } });
  });

  it('hides `_` fields from documents that did not write them', () => {
    const engine = engineWith({
      'actor.yaml': { stats: { _hidden: 3, open: 5 }, peek: '@.stats._hidden' },
      'public.yaml': { '@.stats.sum': '@.stats.open + 1' },
      'sneaky.yaml': { '@.stats.sneak': '@.stats._hidden + 1' },
    });
    const run = (patch: string) => {
      // A `$tmpl` clone, as 5e/main.yaml composes its actor.
      const actor = engine.evalExpr("$tmpl('actor.yaml')", { doc: {}, actor: {}, app: engine.appRoot, current: {} });
      engine.apply(actor, patch);
      return engine.evaluate(actor, { doc: actor, actor, app: engine.appRoot, current: actor }) as {
        peek: number;
        stats: { sum: unknown };
      };
    };
    // The actor reads its own field; public fields cross documents freely.
    const out = run('public.yaml');
    expect(out.peek).toBe(3);
    expect(fieldValue(out.stats.sum)).toBe(6);
    expect(() => run('sneaky.yaml')).toThrow('private field: stats._hidden belongs to actor.yaml, not sneaky.yaml');
  });

  it('lets a patch read the `_` fields it wrote itself', () => {
    const engine = engineWith({
      'actor.yaml': { stats: { open: 5 } },
      'patch.yaml': { '@.stats': { _bonus: 2, total: '@.stats.open + @.stats._bonus' } },
    });
    const actor = structuredClone(engine.docs.get('actor.yaml'));
    engine.apply(actor, 'patch.yaml');
    const out = engine.evaluate(actor, { doc: actor, actor, app: engine.appRoot, current: actor }) as {
      stats: { total: unknown };
    };
    expect(fieldValue(out.stats.total)).toBe(7);
  });
});

describe('apply', () => {
  function appliedEngine(level = 1) {
    const { engine, doc } = testEngine();
    const actorRaw = structuredClone(doc) as Record<string, unknown>;
    engine.docs.set('monk.yaml', {
      '@': 'Player',
      '@.monk': {},
      '@.monk.martial_arts_die': '1d6',
      '@.proficiencies.armor': ['all_armor'],
      '@.features': {
        '+martial_arts': {
          ':doc': 'martial arts mastery',
          '@.proficiencies.weapon': ['+simple_melee', '+light_martial_melee'],
          $if: null,
        },
        '+unarmored_defense': {
          ':doc': 'tough without armor',
        },
        '+monks_focus': {
          ':doc': 'focus points at level 2',
          $if: '@.level >= 2',
        },
      },
      '@.actions.unarmed_strike': {
        $if: '@.level >= 2',
        $then: {
          '@.actions.unarmed_strike.die': '1d8',
          '@.actions.unarmed_strike.type': 'bonus_action',
        },
      },
    });
    actorRaw.proficiencies = { weapon: [] as string[] };
    actorRaw.actions = { unarmed_strike: { die: 'd4', type: 'action' } };
    actorRaw.features = {};
    actorRaw.level = level;
    engine.apply(actorRaw, 'monk.yaml');
    const scope: EvalRoots = { doc: actorRaw, actor: actorRaw, app: engine.appRoot, current: actorRaw };
    return { engine, out: engine.evaluate(actorRaw, scope) as Record<string, any> };
  }

  it('applies additions, path patches and $then blocks', () => {
    const { out } = appliedEngine();
    expect(String(fieldValue((out.monk as Record<string, unknown>).martial_arts_die))).toBe('1d6');
    expect(out.features).toHaveProperty('martial_arts');
    expect(out.features).toHaveProperty('unarmored_defense');
    expect((out.features as Record<string, Record<string, unknown>>).martial_arts?.[':doc']).toBe(
      'martial arts mastery',
    );
    expect(out.armor_class).toBe(12);
    expect(fieldValue((out.proficiencies as Record<string, unknown>).weapon)).toEqual([
      'simple_melee',
      'light_martial_melee',
    ]);
    expect(String((out.actions as { unarmed_strike: { die: unknown } }).unarmed_strike.die)).toBe('d4');
  });

  it('records the writes that produced each patched field, in order', () => {
    const { out } = appliedEngine();
    // The actor tree is a test fixture, not a loaded document, so the origin
    // event has no `:source`; the patch is a registered document, so it does.
    expect(debug((out.monk as Record<string, unknown>).martial_arts_die)).toEqual({
      ':value': expect.anything(),
      ':events': [{ ':source': 'monk.yaml', ':set': '1d6' }],
    });
    // A list of `+item` entries is an addition; a plain list files as `:set`.
    expect((out.proficiencies as Record<string, unknown>).weapon).toEqual({
      ':value': ['simple_melee', 'light_martial_melee'],
      ':events': [{ ':set': [] }, { ':source': 'monk.yaml', ':add': ['simple_melee', 'light_martial_melee'] }],
    });
    expect((out.proficiencies as Record<string, unknown>).armor).toEqual({
      ':value': ['all_armor'],
      ':events': [{ ':source': 'monk.yaml', ':set': ['all_armor'] }],
    });
    // A `+key` addition records who added it, even when the added record is
    // nothing but metadata. A record takes `:events` in place — no wrapper.
    expect((out.features as Record<string, unknown>).unarmored_defense).toEqual({
      ':doc': 'tough without armor',
      ':events': [{ ':source': 'monk.yaml', ':add': 'unarmored_defense' }],
    });
    // Untouched fields stay bare.
    expect(out.armor_class).toBe(12);
  });

  it('gates content on $if conditions with no residue', () => {
    const l1 = appliedEngine(1).out;
    expect(l1.features).not.toHaveProperty('monks_focus');
    expect(String((l1.actions as { unarmed_strike: { die: unknown } }).unarmed_strike.die)).toBe('d4');
    const l2 = appliedEngine(2).out;
    expect(l2.features).toHaveProperty('monks_focus');
    const strike = (l2.actions as { unarmed_strike: Record<string, unknown> }).unarmed_strike;
    expect(String(fieldValue(strike.die))).toBe('1d8');
    expect(fieldValue(strike.type)).toBe('bonus_action');
    // The `$then` write lands over the actor's own `d4`.
    expect(debug(strike.die)).toEqual({
      ':value': '1d8',
      ':events': [{ ':set': 'd4' }, { ':source': 'monk.yaml', ':set': '1d8' }],
    });
  });

  it('replaces a list, unless the patch carries `+item` entries', () => {
    const engine = new GoblinEngine('.');
    const actor = () => ({ proficiencies: { armor: ['leather', 'shields'] } });
    engine.docs.set('plain.yaml', { '@.proficiencies.armor': ['plate'] });
    engine.docs.set('additive.yaml', { '@.proficiencies.armor': ['+plate'] });

    const replaced = engine.apply(actor(), 'plain.yaml') as { proficiencies: { armor: string[] } };
    expect(replaced.proficiencies.armor).toEqual(['plate']);

    const appended = engine.apply(actor(), 'additive.yaml') as { proficiencies: { armor: string[] } };
    expect(appended.proficiencies.armor).toEqual(['leather', 'shields', 'plate']);

    // `+item` is deduplicated against what is already there.
    engine.docs.set('dupe.yaml', { '@.proficiencies.armor': ['+leather'] });
    const deduped = engine.apply(actor(), 'dupe.yaml') as { proficiencies: { armor: string[] } };
    expect(deduped.proficiencies.armor).toEqual(['leather', 'shields']);
  });

  it('adds to a field with a `+` in front of the path', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('bump.yaml', { '+@.attacks': 1, '+@.speed': 5 });
    const actor = engine.apply({ attacks: 1, speed: 30 }, 'bump.yaml') as Record<string, number>;
    expect(actor).toEqual({ attacks: 2, speed: 35 });

    // An added expression stays lazy: it composes with what is there.
    engine.docs.set('gated.yaml', { '+@.attacks': '1 + (@.level >= 11)' });
    const lazy = engine.apply({ attacks: 1, level: 11 }, 'gated.yaml');
    const out = engine.evaluate(lazy, { doc: lazy, actor: lazy, app: engine.appRoot, current: lazy }) as Record<
      string,
      unknown
    >;
    expect(fieldValue(out.attacks)).toBe(3);

    // A missing field is simply written; a record has no scalar to add to.
    expect(engine.apply({}, 'bump.yaml')).toEqual({ attacks: 1, speed: 5 });
    engine.docs.set('bad.yaml', { '+@.hit_points': 1 });
    expect(() => engine.apply({ hit_points: { max: 5 } }, 'bad.yaml')).toThrow(
      'cannot add to +@.hit_points: a record or list is not a value to add to',
    );
  });

  it('inlines a call to a record-bodied definition, params and all', () => {
    const engine = new GoblinEngine('.');
    engine.appRoot.feature = { 'choice()': { ':label': 'Pick', ':param': true, ':type': 'string' } };
    engine.docs.set('grant.yaml', {
      '@.choices.first': '$.feature.choice()',
      '@.choices.second': '$.feature.choice()',
      // A call that yields a number stays an expression, lazy as written.
      '@.armor_class': '$lib.math.floor(12.9)',
    });
    const actor = engine.apply({ choices: {} }, 'grant.yaml') as Record<string, unknown>;
    expect(RecordNode.collectParams(actor)).toEqual([
      { path: 'choices.first', label: 'Pick', type: 'string' },
      { path: 'choices.second', label: 'Pick', type: 'string' },
    ]);

    engine.docs.set('actor.yaml', actor);
    const resolved = engine.resolve('actor.yaml', [
      parameter('choices.first', 'a'),
      parameter('choices.second', 'b'),
    ]) as {
      data: { choices: Record<string, Record<string, unknown>> };
    };
    // Each call got its own copy — one filled value does not leak into the other.
    expect(resolved.data.choices.first?.[':value']).toBe('a');
    expect(resolved.data.choices.second?.[':value']).toBe('b');
    expect((actor as { armor_class: unknown }).armor_class).toBe('$lib.math.floor(12.9)');
  });

  it('inlines a `$tmpl(…)` patch value, params and all', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('choice.yaml', { ':label': 'Pick', ':param': true, ':type': 'string' });
    engine.docs.set('grant.yaml', { '@.choices.first': "$tmpl('choice.yaml')" });
    const actor = engine.apply({ choices: {} }, 'grant.yaml');
    // The record lands in the tree, so the param is asked for by its path.
    expect(RecordNode.collectParams(actor)).toEqual([{ path: 'choices.first', label: 'Pick', type: 'string' }]);
    engine.docs.set('actor.yaml', actor);
    expect(engine.resolve('actor.yaml', [parameter('choices.first', 'athletics')])).toEqual({
      data: { choices: { first: { ':label': 'Pick', ':param': true, ':type': 'string', ':value': 'athletics' } } },
    });
  });

  it('rejects a list that mixes `+item` additions with plain items', () => {
    const engine = new GoblinEngine('.');
    const actor = () => ({ proficiencies: { armor: [] as string[] } });
    engine.docs.set('mixed.yaml', { '@.proficiencies.armor': ['+plate', 'leather'] });
    expect(() => engine.apply(actor(), 'mixed.yaml')).toThrow(
      "mixed list patch: @.proficiencies.armor combines '+item' additions with plain items",
    );
    // Nested under a path key, the field's own key names the offender.
    engine.docs.set('nested.yaml', { '@.proficiencies': { armor: ['plate', '+leather'] } });
    expect(() => engine.apply(actor(), 'nested.yaml')).toThrow('mixed list patch: armor combines');
  });

  it('respects a false $if condition', () => {
    const { engine, doc } = testEngine();
    const actorRaw = structuredClone(doc) as Record<string, unknown>;
    actorRaw.features = {};
    engine.docs.set('gated.yaml', {
      '@.features': {
        '+sneak_attack': {
          $if: '$.hit_points.current > $.hit_points.max',
          $then: { '@.features': { '+never': {} } },
        },
      },
    });
    engine.apply(actorRaw, 'gated.yaml');
    const scope: EvalRoots = { doc: actorRaw, actor: actorRaw, app: engine.appRoot, current: actorRaw };
    const out = engine.evaluate(actorRaw, scope) as Record<string, { never?: unknown; sneak_attack?: unknown }>;
    // A false $if merges nothing at all — neither wrapper nor $then content.
    expect(out.features).not.toHaveProperty('sneak_attack');
    expect(out.features).not.toHaveProperty('never');
  });

  it('reads # as the defining document in function bodies and call copies', () => {
    const engine = new GoblinEngine('.');
    engine.register('helpers.yaml', {
      k: 10,
      'scaled(x)': 'x * #.k',
      'entry(x)': { value: '#.scaled(x)' },
    });
    // No app-root fallback: only the defining document holds `k` and `scaled`.
    for (const key of ['k', 'scaled(x)', 'entry(x)']) delete engine.appRoot[key];
    engine.appRoot.helpers = "$tmpl('helpers.yaml')";

    const actor: Record<string, unknown> = {
      k: 1,
      direct: '$.helpers.scaled(2)',
      stat: '$.helpers.entry(3)',
    };
    const scope: EvalRoots = { doc: actor, actor, app: engine.appRoot, current: actor };
    const out = engine.evaluate(actor, scope) as { direct: number; stat: { value: number } };
    expect(out.direct).toBe(20);
    expect(out.stat.value).toBe(30);
  });

  it('gates a whole document on a root $if', () => {
    const { engine, doc } = testEngine();
    const actor = () => ({ ...(structuredClone(doc) as Record<string, unknown>), level: 3, features: {} });
    const patch = (cond: string) => ({
      $if: cond,
      $then: { '@.features': { '+bonus': {} } },
      '@.features': { '+gated': {} },
    });
    engine.docs.set('closed.yaml', patch('@.level >= 5'));
    engine.docs.set('open.yaml', patch('@.level >= 2'));

    const closed = engine.apply(actor(), 'closed.yaml') as { features: Record<string, unknown> };
    expect(closed.features).toEqual({});
    const open = engine.apply(actor(), 'open.yaml') as { features: Record<string, unknown> };
    expect(Object.keys(open.features).sort()).toEqual(['bonus', 'gated']);
  });
});

describe('validate', () => {
  it('passes valid nodes and reports failures', () => {
    const { engine } = testEngine();
    const out = engine.evaluateDoc('main.yaml');
    expect(engine.validate(out)).toEqual([]);

    const bad = { hit_points: { '!validate': ['.current >= 0'], current: -2 } };
    expect(engine.validate(bad)).toEqual(['.current >= 0']);
  });
});

describe('validate with patched fields', () => {
  it('sees through `{ :value, :events }` in predicates', () => {
    const engine = new GoblinEngine('.');
    const actor: Record<string, unknown> = {
      hit_points: { '!validate': ['.current >= 0', '.current <= .max'], current: 5, max: 5 },
    };
    engine.docs.set('patch.yaml', { '@.hit_points': { max: 12, current: '@.hit_points.max' } });
    engine.apply(actor, 'patch.yaml');
    const out = engine.evaluate(actor, { doc: actor, actor, app: engine.appRoot, current: actor });
    expect(fieldValue((out as { hit_points: Record<string, unknown> }).hit_points.current)).toBe(12);
    expect(engine.validate(out)).toEqual([]);
  });
});

describe('debug', () => {
  it('converts dice and functions to JSON-friendly values', () => {
    expect(debug(new Die(1, 6, '1d6'))).toBe('1d6');
    expect(debug(function roll() {})).toBe('[fn roll()]');
    expect(debug({ a: [new Die(1, 4, 'd4')] })).toEqual({ a: ['d4'] });
  });

  it('prints tagged functions as :type/:source/:params/:deps objects', () => {
    const { engine } = testEngine();
    const out = engine.evaluateDoc('main.yaml') as Record<string, any>;
    expect(debug(out.utils.ability_modifier)).toEqual({
      ':type': 'function',
      ':params': ['x'],
      ':source': '$lib.math.floor((x - 10) / 2)',
      ':deps': [],
    });
    expect(debug((out.initiative as { roll: unknown }).roll)).toEqual({
      ':type': 'function',
      ':params': [],
      ':source': '1d20 + .base',
      ':deps': ['.base'],
    });
    expect(debug((out.rest as { short: unknown }).short)).toEqual({
      ':type': 'function',
      ':params': [],
      ':source': '$.hit_points.current = $lib.math.min($.hit_points.current + $.hit_die, $.hit_points.max)',
      ':deps': ['$.hit_points.current', '$.hit_die', '$.hit_points.max'],
    });
  });
});

describe('FunctionNode.detectDeps', () => {
  it('collects refs in order, deduplicated', () => {
    expect(FunctionNode.detectDeps('$.utils.ability_modifier(.base)')).toEqual(['$.utils.ability_modifier', '.base']);
    expect(FunctionNode.detectDeps('#.a + #.a + #.b')).toEqual(['#.a', '#.b']);
  });

  it('ignores string literals, dice, and dot-less sigils normalized', () => {
    expect(FunctionNode.detectDeps("$tmpl('a.yaml')")).toEqual(['$.tmpl']);
    expect(FunctionNode.detectDeps('#math.max(3, 5)')).toEqual(['#.math.max']);
    expect(FunctionNode.detectDeps('1d20 + 2')).toEqual([]);
  });

  it('omits $lib refs', () => {
    expect(FunctionNode.detectDeps('$lib.math.floor(2.9)')).toEqual([]);
    expect(FunctionNode.detectDeps('$.lib.math.min(3, 5)')).toEqual([]);
    expect(FunctionNode.detectDeps('$.x + $lib.math.max(1, 2)')).toEqual(['$.x']);
  });

  it('trims whitespace from printed source', () => {
    const fn = FunctionNode.tag(() => 1, { name: 'f', params: [], source: '  1d20 + 2\n', deps: [] });
    expect(debug(fn)).toEqual({ ':type': 'function', ':params': [], ':source': '1d20 + 2', ':deps': [] });
  });
});

describe('parameters', () => {
  const doc = {
    hero_name: { ':label': 'Hero Name', ':doc': 'The hero name.', ':param': true, ':type': 'string' },
    level: { ':doc': 'Starting level.', ':param': 'start_level', ':type': 'integer' },
    attack_die: { ':param': true, ':type': 'die' },
    details: { title: { ':param': true } },
    hit_points: { value: 10, max: 10 },
  };

  it('collects missing params with paths, labels, docs, and types', () => {
    expect(RecordNode.collectParams(doc)).toEqual([
      { path: 'hero_name', label: 'Hero Name', doc: 'The hero name.', type: 'string' },
      { path: 'start_level', doc: 'Starting level.', type: 'integer' },
      { path: 'attack_die', type: 'die' },
      { path: 'details.title' },
    ]);
  });

  it('keys params by where they live, not where the reference was written', () => {
    const engine = new GoblinEngine('.');
    const picks = {
      choices: { first: { ':param': true, ':type': 'string' } },
      // Reads the whole table, so its params fill by their own dotted path.
      taken: "$lib.list.count(@.choices, 'athletics')",
    };
    engine.docs.set('picks.yaml', picks);
    const out = engine.evaluateDoc('picks.yaml', [parameter('choices.first', 'athletics')]) as Record<string, unknown>;
    expect(out.taken).toBe(1);
  });

  it('expands record calls written as plain document values', () => {
    const engine = new GoblinEngine('.');
    engine.appRoot.ability = {
      'entry(ability)': {
        bought: { ':label': 'Ability score', ':param': true, ':type': 'integer' },
        doubled: '.bought * 2',
        named: '$lib.list.count(@.improvements, ability)',
      },
    };
    const doc = {
      improvements: ['wisdom', 'wisdom'],
      strength: "$.ability.entry('strength')",
      wisdom: "$.ability.entry('wisdom')",
    };
    engine.docs.set('sheet.yaml', doc);

    // The call is a node by the time params are collected.
    expect(engine.missingParams('sheet.yaml').map((p) => p.path)).toEqual(['strength.bought', 'wisdom.bought']);
    const out = engine.evaluateDoc('sheet.yaml', [
      parameter('strength.bought', 8),
      parameter('wisdom.bought', 10),
    ]) as Record<string, Record<string, unknown>>;
    expect(out.strength?.doubled).toBe(16);
    expect(out.strength?.named).toBe(0);
    expect(out.wisdom?.named).toBe(2);
  });

  it('rejects unknown param types', () => {
    expect(() => RecordNode.collectParams({ x: { ':param': true, ':type': 'spell' } })).toThrow(
      'unknown param type: spell (at x)',
    );
    expect(() => RecordNode.checkParamType('spell', 'x', 'x')).toThrow('unknown param type');
  });

  it('fills provided values at evaluate time, null when missing', () => {
    const engine = new GoblinEngine('.');
    const scope = (inputs?: InputEvent[]): EvalRoots => ({
      doc,
      actor: doc,
      app: engine.appRoot,
      current: doc,
      path: [],
      inputs,
    });
    const out = engine.evaluate(
      doc,
      scope([parameter('hero_name', 'Aria'), parameter('start_level', 3), parameter('attack_die', '1d8')]),
    ) as Record<string, Record<string, unknown>>;
    expect(out.hero_name).toEqual({
      ':label': 'Hero Name',
      ':doc': 'The hero name.',
      ':param': true,
      ':type': 'string',
      ':value': 'Aria',
    });
    expect(out.level).toEqual({ ':doc': 'Starting level.', ':param': 'start_level', ':type': 'integer', ':value': 3 });
    expect(out.attack_die?.[':value']).toBeInstanceOf(Die);
    expect(out.attack_die?.[':param']).toBe(true);
    expect((out.details as unknown as Record<string, Record<string, unknown>>).title).toEqual({
      ':param': true,
      ':value': null,
    });
    expect(out.hit_points).toEqual({ value: 10, max: 10 });
  });

  it('throws on provided values of the wrong type', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('params.yaml', doc);
    expect(() => engine.evaluateDoc('params.yaml', [parameter('start_level', 'high')])).toThrow(
      'param type mismatch: start_level expected integer, got string',
    );
    expect(() => engine.evaluateDoc('params.yaml', [parameter('hero_name', 42)])).toThrow(
      'param type mismatch: hero_name expected string, got number',
    );
  });

  it('uses defaults when unprovided, provided wins, mistyped defaults throw', () => {
    const engine = new GoblinEngine('.');
    const doc = {
      greeting: { ':doc': 'Hi.', ':param': true, ':type': 'string', ':default': 'hello' },
      retries: { ':param': true, ':type': 'integer', ':default': 3 },
      nick: { ':param': true },
    };
    expect(RecordNode.collectParams(doc)).toEqual([{ path: 'nick' }]);
    const scope = (inputs?: InputEvent[]): EvalRoots => ({
      doc,
      actor: doc,
      app: engine.appRoot,
      current: doc,
      path: [],
      inputs,
    });
    const out = engine.evaluate(doc, scope()) as Record<string, Record<string, unknown>>;
    expect(out.greeting).toEqual({
      ':doc': 'Hi.',
      ':param': true,
      ':type': 'string',
      ':default': 'hello',
      ':value': 'hello',
    });
    expect(out.retries).toEqual({ ':param': true, ':type': 'integer', ':default': 3, ':value': 3 });
    expect(out.nick).toEqual({ ':param': true, ':value': null });
    const over = engine.evaluate(doc, scope([parameter('greeting', 'yo'), parameter('retries', 5)])) as Record<
      string,
      Record<string, unknown>
    >;
    expect(over.greeting?.[':value']).toBe('yo');
    expect(over.retries?.[':value']).toBe(5);
    expect(() => engine.evaluate({ x: { ':param': true, ':type': 'integer', ':default': 'many' } }, scope())).toThrow(
      'param type mismatch: x expected integer, got string',
    );
  });

  it('dereferences :param records to their filled value', () => {
    const engine = new GoblinEngine('.');
    const doc = {
      xp: { ':doc': 'XP.', ':param': true, ':type': 'integer' },
      double: '@.xp + @.xp',
    };
    engine.docs.set('p.yaml', doc);
    const out = engine.evaluateDoc('p.yaml', [parameter('xp', 6500)]) as { double?: unknown };
    expect(out.double).toBe(13000);
    const missing = engine.evaluateDoc('p.yaml') as { double?: unknown };
    expect(missing.double).toBe(0);
  });

  it('dereferences defaults without provided values', () => {
    const engine = new GoblinEngine('.');
    const doc = {
      xp: { ':param': true, ':type': 'integer', ':default': 0 },
      level: '@.xp',
    };
    engine.docs.set('p.yaml', doc);
    const out = engine.evaluateDoc('p.yaml') as { level?: unknown };
    expect(out.level).toBe(0);
  });

  it('refuses .value reads on :param records but keeps data slots', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('param.yaml', {
      xp: { ':param': true, ':type': 'integer' },
      alias: '@.xp.value',
    });
    expect(() => engine.evaluateDoc('param.yaml', [parameter('xp', 1)])).toThrow('unresolvable reference: @.xp.value');
    engine.docs.set('data.yaml', { hp: { value: 3, max: 5 }, alias: '@.hp.value' });
    const out = engine.evaluateDoc('data.yaml') as { alias?: unknown };
    expect(out.alias).toBe(3);
  });

  it('exposes missing params for loaded documents', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('params.yaml', doc);
    expect(engine.missingParams('params.yaml')).toEqual([
      { path: 'hero_name', label: 'Hero Name', doc: 'The hero name.', type: 'string' },
      { path: 'start_level', doc: 'Starting level.', type: 'integer' },
      { path: 'attack_die', type: 'die' },
      { path: 'details.title' },
    ]);
    const out = engine.evaluateDoc('params.yaml', [parameter('hero_name', 'Aria')]) as Record<
      string,
      Record<string, unknown>
    >;
    expect(out.hero_name?.[':value']).toBe('Aria');
    expect(out.level).toEqual({
      ':doc': 'Starting level.',
      ':param': 'start_level',
      ':type': 'integer',
      ':value': null,
    });
  });

  it('resolves to data when satisfied, query with only outstanding params when not', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('params.yaml', doc);

    const empty = engine.resolve('params.yaml');
    expect(empty).toEqual({
      query: [
        { path: 'hero_name', label: 'Hero Name', doc: 'The hero name.', type: 'string' },
        { path: 'start_level', doc: 'Starting level.', type: 'integer' },
        { path: 'attack_die', type: 'die' },
        { path: 'details.title' },
      ],
    });

    const partial = engine.resolve('params.yaml', [parameter('hero_name', 'Aria')]);
    expect(partial).toEqual({
      query: [
        { path: 'start_level', doc: 'Starting level.', type: 'integer' },
        { path: 'attack_die', type: 'die' },
        { path: 'details.title' },
      ],
    });

    const full = engine.resolve('params.yaml', [
      parameter('hero_name', 'Aria'),
      parameter('start_level', 3),
      parameter('attack_die', '1d8'),
      parameter('details.title', 'Kid'),
    ]) as { data: Record<string, unknown> };
    expect(full.data.hero_name).toEqual({
      ':label': 'Hero Name',
      ':doc': 'The hero name.',
      ':param': true,
      ':type': 'string',
      ':value': 'Aria',
    });
    expect(full.data.level).toEqual({
      ':doc': 'Starting level.',
      ':param': 'start_level',
      ':type': 'integer',
      ':value': 3,
    });
    expect(full.data.attack_die).toEqual({ ':param': true, ':type': 'die', ':value': '1d8' });
    expect((full.data.details as unknown as Record<string, unknown>).title).toEqual({
      ':param': true,
      ':value': 'Kid',
    });
  });

  it('validates array parameters', () => {
    const engine = new GoblinEngine('.');
    const doc = { tags: { ':doc': 'Tags.', ':param': true, ':type': 'array' } };
    expect(RecordNode.collectParams(doc)).toEqual([{ path: 'tags', doc: 'Tags.', type: 'array' }]);
    const scope = (inputs?: InputEvent[]): EvalRoots => ({
      doc,
      actor: doc,
      app: engine.appRoot,
      current: doc,
      path: [],
      inputs,
    });
    const filled = engine.evaluate(doc, scope([parameter('tags', ['a', 'b'])])) as Record<
      string,
      Record<string, unknown>
    >;
    expect(filled.tags).toEqual({ ':doc': 'Tags.', ':param': true, ':type': 'array', ':value': ['a', 'b'] });
    const empty = engine.evaluate(doc, scope([parameter('tags', [])])) as Record<string, Record<string, unknown>>;
    expect(empty.tags?.[':value']).toEqual([]);
    expect(() => engine.evaluate(doc, scope([parameter('tags', 'nope')]))).toThrow(
      'param type mismatch: tags expected array, got string',
    );
  });

  it('resolve returns data for documents without params', () => {
    const { engine } = testEngine();
    const resolved = engine.resolve('main.yaml') as { data: Record<string, unknown> };
    expect((resolved.data.abilities as Record<string, { modifier: number }>).strength?.modifier).toBe(2);
  });

  it('replays the input stream: the latest event per path wins, overrides cite its version', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('ov.yaml', { computed: '1 + 1', name: { ':param': true } });
    const inputs = [
      parameter('name', 'Aria', 1),
      override('computed', 5, 1),
      parameter('name', 'Bree', 2),
      override('computed', 7, 3),
    ];
    const resolved = engine.resolve('ov.yaml', inputs) as { data: Record<string, Record<string, unknown>> };
    expect(resolved.data.computed).toEqual({
      ':value': 7,
      ':events': [{ ':set': '1 + 1' }, { ':source': 'override', ':version': 3, ':set': 7 }],
    });
    expect(resolved.data.name?.[':value']).toBe('Bree');
  });

  it('invokes functions on the resolved tree, returning the last result', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('fn.yaml', {
      hp: 5,
      base: 10,
      'heal(n)': '@.hp += n',
      'double(x)': 'x * 2',
      'shield(bonus)': { armor: '#.base + bonus' },
    });
    expect(engine.resolve('fn.yaml', [invoke('double', [1]), invoke('double', [21])])).toMatchObject({ result: 42 });
    expect(engine.resolve('fn.yaml', [invoke('shield', [3])])).toMatchObject({ result: { armor: 13 } });
    expect(engine.resolve('fn.yaml')).not.toHaveProperty('result');
    expect(() => engine.resolve('fn.yaml', [invoke('hp')])).toThrow('invoke: hp is not a function');

    const healed = engine.resolve('fn.yaml', [invoke('heal', [2]), invoke('heal', [3])]) as {
      data: Record<string, unknown>;
      result: unknown;
    };
    // An assignment statement returns nothing.
    expect(healed.result).toBeNull();
    expect(fieldValue(healed.data.hp)).toBe(10);
  });

  it('logs every write in order, crediting assignments to the invoke that made them', () => {
    const engine = new GoblinEngine('.');
    engine.register('boon.yaml', { '@': 'Hero', '@.speed': 40, '+@.gold': 5 });
    engine.register('hero.yaml', {
      $actor: 'Hero',
      speed: 30,
      gold: 1,
      hp: { current: 2, max: 9 },
      boon: "$mixin('boon.yaml')",
      'rest()': '@.hp.current = @.hp.max',
    });
    const rest = invoke('rest', [], 2);
    const state = engine.resolve('hero.yaml', [rest]) as { data: unknown };
    const actor = engine.docs.get('hero.yaml');
    expect(engine.events(actor, state.data)).toEqual([
      { event: { type: 'set', path: 'speed', value: 40, source: 'boon.yaml' } },
      { event: { type: 'add', path: 'gold', value: 5, source: 'boon.yaml' } },
      { cause: rest, phase: rest, event: { type: 'set', path: 'hp.current', value: 9, source: 'hero.yaml' } },
    ]);
  });

  it("freezes an invoke's writes on replay, while patch writes follow changed inputs", () => {
    const hero = () => {
      const engine = new GoblinEngine('.');
      engine.register('hero.yaml', {
        $actor: 'Hero',
        level: 1,
        hp: { max: '@.level * 10', current: 1 },
        'rest()': '@.hp.current = @.hp.max',
      });
      return engine;
    };
    const run = (events: StateEvent[]) => {
      const engine = hero();
      const state = engine.resolve('hero.yaml', events) as { data: { hp: Record<string, unknown> } };
      const writes = engine.events(engine.docs.get('hero.yaml'), state.data);
      return {
        hp: { max: state.data.hp.max, current: fieldValue(state.data.hp.current) },
        writes: writes.map(({ cause, version, event }) => ({ version: version ?? cause?.version ?? 1, ...event })),
      };
    };
    const rested = run([invoke('rest', [], 1)]);
    expect(rested.hp).toEqual({ max: 10, current: 10 });
    // Levelling up later: the rest already happened, at the old max.
    const levelled = run([invoke('rest', [], 1), ...rested.writes, override('level', 2, 2)]);
    expect(levelled.hp).toEqual({ max: 20, current: 10 });
    expect(levelled.writes).toEqual(rested.writes);
  });

  it('records every die rolled and replays it, wherever it rolled', () => {
    const hero = () => {
      const engine = new GoblinEngine('.');
      engine.register('boon.yaml', { '@': 'Hero', '@.strength': '$lib.dice.keep_highest(4, 6, 3)' });
      engine.register('hero.yaml', {
        $actor: 'Hero',
        hp: 10,
        bonus: 2,
        strength: 0,
        initiative: '1d20 + .bonus',
        boon: "$mixin('boon.yaml')",
        'heal()': '@.hp += 1d10',
        'luck()': '1d6 + .bonus',
      });
      return engine;
    };
    const run = (events: StateEvent[]) => {
      const engine = hero();
      const state = engine.resolve('hero.yaml', events) as { data: Record<string, unknown>; result?: unknown };
      const made = engine.events(engine.docs.get('hero.yaml'), state.data);
      return {
        strength: fieldValue(state.data.strength),
        hp: fieldValue(state.data.hp),
        initiative: state.data.initiative,
        result: state.result,
        made: made.map(({ cause, version, event }) => ({ version: version ?? cause?.version ?? 9, ...event })),
      };
    };
    const heal = invoke('heal', [], 2);
    const luck = invoke('luck', [], 3);
    const random = vi.spyOn(Math, 'random');
    try {
      random.mockReturnValue(0.99); // every face a 6, a 10 or a 20
      const first = run([heal, luck]);
      expect(first).toMatchObject({ strength: 18, hp: 20, initiative: 22, result: 8 });
      const rolls = first.made.filter((event) => event.type === 'roll');
      expect(rolls.map(({ path, dice, value }) => [path, dice, value])).toEqual([
        ['heal', '1d10', [10]],
        ['luck', '1d6', [6]],
        // `keep_highest(4, 6, 3)` is one roll of four dice, every face kept.
        ['strength', '4d6', [6, 6, 6, 6]],
        ['initiative', '1d20', [20]],
      ]);
      random.mockReturnValue(0); // every face a 1
      // Every recorded roll comes back: fields, invoked calls, and what they wrote.
      expect(run([heal, luck, ...first.made])).toMatchObject({
        strength: 18,
        hp: 20,
        initiative: 22,
        result: 8,
        made: first.made,
      });
      // Without them, the dice roll again.
      expect(run([heal, luck])).toMatchObject({ strength: 3, hp: 11, initiative: 3, result: 3 });
    } finally {
      random.mockRestore();
    }
  });

  it('rolls afresh for each invoke of the same function', () => {
    const engine = new GoblinEngine('.');
    engine.register('hero.yaml', { $actor: 'Hero', hp: 0, 'heal()': '@.hp += 1d10' });
    const random = vi.spyOn(Math, 'random');
    try {
      random.mockReturnValueOnce(0.15).mockReturnValueOnce(0.65); // 2, then 7
      const state = engine.resolve('hero.yaml', [invoke('heal', [], 1), invoke('heal', [], 2)]) as {
        data: Record<string, unknown>;
      };
      expect(fieldValue(state.data.hp)).toBe(9);
    } finally {
      random.mockRestore();
    }
  });

  it('replays sets and invokes in stream order', () => {
    const run = (inputs: InputEvent[]) => {
      const engine = new GoblinEngine('.');
      engine.docs.set('fn.yaml', { hp: 5, 'heal(n)': '@.hp += n' });
      return fieldValue((engine.resolve('fn.yaml', inputs) as { data: Record<string, unknown> }).data.hp);
    };
    // An earlier set is the base the call heals from; a later one wins over it.
    expect(run([override('hp', 1, 1), invoke('heal', [4], 2)])).toBe(5);
    expect(run([invoke('heal', [4], 1), override('hp', 1, 2)])).toBe(1);
  });

  it('resolve honors overrides over derived and missing values', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('ov.yaml', {
      computed: '1 + 1',
      name: { ':doc': 'Your name.', ':param': true },
    });
    const resolved = engine.resolve('ov.yaml', [
      override('computed', 99),
      override('brand.new', 1),
      override('name', 'Aria'),
    ]) as {
      data: Record<string, unknown>;
    };
    // An override is a change like any other: it prints with its event.
    expect(resolved.data).toEqual({
      computed: {
        ':value': 99,
        ':events': [{ ':set': '1 + 1' }, { ':source': 'override', ':version': 1, ':set': 99 }],
      },
      brand: { new: { ':value': 1, ':events': [{ ':source': 'override', ':version': 1, ':set': 1 }] } },
      name: {
        ':value': 'Aria',
        ':events': [
          { ':set': { ':doc': 'Your name.', ':param': true } },
          { ':source': 'override', ':version': 1, ':set': 'Aria' },
        ],
      },
    });
    expect(print(resolved.data)).toEqual({ computed: 99, brand: { new: 1 }, name: 'Aria' });
  });

  it('resolve keeps :type contracts on overridden params', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('ov.yaml', {
      level: { ':doc': 'Level.', ':param': true, ':type': 'integer' },
    });
    expect(() => engine.resolve('ov.yaml', [override('level', 'high')])).toThrow(
      'param type mismatch: level expected integer, got string',
    );
  });

  it('enforces :options membership for scalar and array values', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('choice.yaml', {
      style: { ':param': true, ':type': 'string', ':options': ['archery', 'dueling'] },
      skills: { ':param': true, ':type': 'array', ':options': ['arcana', 'history'] },
    });
    const good = engine.evaluateDoc('choice.yaml', [
      parameter('style', 'dueling'),
      parameter('skills', ['arcana']),
    ]) as Record<string, Record<string, unknown>>;
    expect(good.style?.[':value']).toBe('dueling');
    expect(good.skills?.[':value']).toEqual(['arcana']);
    expect(() =>
      engine.evaluateDoc('choice.yaml', [parameter('style', 'sneaky'), parameter('skills', ['arcana'])]),
    ).toThrow('param options mismatch: style expected one of ["archery", "dueling"], got "sneaky"');
    expect(() =>
      engine.evaluateDoc('choice.yaml', [parameter('style', 'dueling'), parameter('skills', ['arcana', 'sneak'])]),
    ).toThrow('param options mismatch: skills[1] expected one of ["arcana", "history"], got "sneak"');
  });

  it('enforces :unique distinctness and :count length on arrays', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('skills.yaml', {
      trained: { ':param': true, ':type': 'array', ':options': ['a', 'b', 'c'], ':count': 2, ':unique': true },
    });
    const good = engine.evaluateDoc('skills.yaml', [parameter('trained', ['a', 'b'])]) as Record<
      string,
      Record<string, unknown>
    >;
    expect(good.trained?.[':value']).toEqual(['a', 'b']);
    expect(() => engine.evaluateDoc('skills.yaml', [parameter('trained', ['a', 'a'])])).toThrow(
      'param uniqueness mismatch: trained has duplicate item "a"',
    );
    expect(() => engine.evaluateDoc('skills.yaml', [parameter('trained', ['a'])])).toThrow(
      'param count mismatch: trained expected 2 items, got 1',
    );
    expect(() => engine.evaluateDoc('skills.yaml', [parameter('trained', ['a', 'b', 'c'])])).toThrow(
      'param count mismatch: trained expected 2 items, got 3',
    );
  });

  it('enforces :min/:max bounds inclusively, per item on arrays', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('bounds.yaml', {
      score: { ':param': true, ':type': 'integer', ':min': 8, ':max': 15 },
      rolls: { ':param': true, ':type': 'array', ':min': 1 },
    });
    const good = engine.evaluateDoc('bounds.yaml', [parameter('score', 8), parameter('rolls', [1, 6])]) as Record<
      string,
      Record<string, unknown>
    >;
    expect(good.score?.[':value']).toBe(8);
    expect(() => engine.evaluateDoc('bounds.yaml', [parameter('score', 16), parameter('rolls', [1])])).toThrow(
      'param range mismatch: score expected 8 to 15, got 16',
    );
    expect(() => engine.evaluateDoc('bounds.yaml', [parameter('score', 7), parameter('rolls', [1])])).toThrow(
      'param range mismatch: score expected 8 to 15, got 7',
    );
    expect(() => engine.evaluateDoc('bounds.yaml', [parameter('score', 10), parameter('rolls', [3, 0])])).toThrow(
      'param range mismatch: rolls[1] expected at least 1, got 0',
    );
    expect(() => RecordNode.checkParamConstraints({ ':max': 2 }, 3, 'x')).toThrow(
      'param range mismatch: x expected at most 2, got 3',
    );
    expect(() => RecordNode.checkParamConstraints({ ':min': 'low' }, 3, 'x')).toThrow(
      'invalid :min for x: expected number, got string',
    );
    expect(RecordNode.collectParams({ score: { ':param': true, ':type': 'integer', ':min': 8, ':max': 15 } })).toEqual([
      { path: 'score', type: 'integer', min: 8, max: 15 },
    ]);
  });

  it('validates constraint declarations and default values', () => {
    expect(() => RecordNode.checkParamConstraints({ ':options': 'nope' }, 'x', 'x')).toThrow(
      'invalid :options for x: expected array, got string',
    );
    expect(() => RecordNode.checkParamConstraints({ ':count': 'two' }, ['a'], 'x')).toThrow(
      'invalid :count for x: expected non-negative integer, got string',
    );
    expect(() => RecordNode.checkParamConstraints({ ':count': -1 }, ['a'], 'x')).toThrow(
      'invalid :count for x: expected non-negative integer, got number',
    );
    const engine = new GoblinEngine('.');
    engine.docs.set('def.yaml', {
      bad_default: { ':param': true, ':type': 'array', ':options': ['a'], ':count': 1, ':default': ['b'] },
    });
    expect(() => engine.evaluateDoc('def.yaml')).toThrow(
      'param options mismatch: bad_default[0] expected one of ["a"], got "b"',
    );
  });

  it('reports choice constraints in missing params', () => {
    expect(
      RecordNode.collectParams({
        trained: { ':param': true, ':type': 'array', ':options': ['a', 'b'], ':count': 2, ':unique': true },
      }),
    ).toEqual([{ path: 'trained', type: 'array', options: ['a', 'b'], count: 2, unique: true }]);
  });

  it('keeps choice contracts on overridden params', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('ov.yaml', {
      trained: { ':param': true, ':type': 'array', ':options': ['a', 'b'], ':count': 1 },
    });
    expect(() => engine.resolve('ov.yaml', [override('trained', ['z'])])).toThrow(
      'param options mismatch: trained[0] expected one of ["a", "b"], got "z"',
    );
    expect(() => engine.resolve('ov.yaml', [override('trained', ['a', 'b'])])).toThrow(
      'param count mismatch: trained expected 1 items, got 2',
    );
    const ok = engine.resolve('ov.yaml', [override('trained', ['a'])]) as { data: Record<string, unknown> };
    expect(fieldValue(ok.data.trained)).toEqual(['a']);
  });
});
