import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { GoblinEngine } from './engine';
import { Die, DieNode } from './nodes/die';
import { ExpressionNode } from './nodes/expression';
import { FunctionNode } from './nodes/function';
import { RecordNode } from './nodes/record';
import { debug, print } from './nodes/serialize';
import { type EvalRoots, parseRef } from './utils';

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
    expect(() => engine.evalExpr('#.name[0]', scopeOf(doc))).toThrow('cannot index string: not a list');
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
  const boon = { $: 'Hero', '@.speed': 40, '+@.gold': 5 };
  const engineWith = (docs: Record<string, unknown>) => {
    const engine = new GoblinEngine('.');
    for (const [file, doc] of Object.entries(docs)) engine.register(file, doc);
    return engine;
  };

  it('merges into the actor document that calls it, consuming the key', () => {
    const engine = engineWith({
      'boon.yaml': boon,
      'hero.yaml': { $: 'Hero', speed: 30, gold: 1, boon: "$mixin('boon.yaml')" },
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
      'hero.yaml': { $: 'Hero', speed: 30, gold: 1, gifts: { first: "$mixin('boon.yaml')" } },
    });
    const state = engine.resolve('hero.yaml') as { data: Record<string, unknown> };
    expect(state.data).not.toHaveProperty('gifts');
    expect(fieldValue(state.data.speed)).toBe(40);
  });

  it('merges into the actor a patch applies to, leaving no empty record behind', () => {
    const engine = engineWith({
      'boon.yaml': boon,
      'hero.yaml': { $: 'Hero', speed: 30, gold: 1 },
      'class.yaml': { $: 'Hero', '@.hp': 10, extras: { blessing: "$mixin('boon.yaml')" } },
    });
    const actor = engine.evalExpr("$tmpl('hero.yaml')", { doc: {}, actor: {}, app: engine.appRoot, current: {} });
    engine.apply(actor, 'class.yaml');
    expect(actor).toMatchObject({ speed: 40, gold: 6, hp: 10 });
    expect(actor).not.toHaveProperty('extras');
  });

  it('walks up the template chain to the nearest document of its type', () => {
    const engine = engineWith({ 'boon.yaml': boon, 'kit.yaml': { blessing: "$mixin('boon.yaml')" } });
    const hero: Record<string, unknown> = { $: 'Hero', speed: 30, gold: 1 };
    const scope: EvalRoots = { doc: hero, actor: hero, app: engine.appRoot, current: hero };
    // `kit.yaml` declares no type: its mixin lands on the Hero that pulled it in.
    const kit = engine.evalExpr("$tmpl('kit.yaml')", scope);
    engine.applyRaw(hero, kit);
    expect(hero).toMatchObject({ speed: 40, gold: 6 });
  });

  it('requires a typed mixin and a parent document of the same type', () => {
    const untyped = engineWith({
      'loose.yaml': { '@.speed': 1 },
      'hero.yaml': { $: 'Hero', x: "$mixin('loose.yaml')" },
    });
    expect(() => untyped.resolve('hero.yaml')).toThrow(
      'mixin loose.yaml must declare its actor type with a top-level `$`',
    );
    const stranger = engineWith({ 'boon.yaml': boon, 'pet.yaml': { $: 'Pet', x: "$mixin('boon.yaml')" } });
    expect(() => stranger.resolve('pet.yaml')).toThrow(
      "$mixin('boon.yaml'): no parent document defines actor type Hero",
    );
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
      $: 'Player',
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
    const resolved = engine.resolve('actor.yaml', { 'choices.first': 'a', 'choices.second': 'b' }) as {
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
    expect(engine.resolve('actor.yaml', { 'choices.first': 'athletics' })).toEqual({
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
    actorRaw['features'] = {};
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
    const out = engine.evaluateDoc('picks.yaml', { 'choices.first': 'athletics' }) as Record<string, unknown>;
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
    const out = engine.evaluateDoc('sheet.yaml', { 'strength.bought': 8, 'wisdom.bought': 10 }) as Record<
      string,
      Record<string, unknown>
    >;
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
    const scope = (provided?: Record<string, unknown>): EvalRoots => ({
      doc,
      actor: doc,
      app: engine.appRoot,
      current: doc,
      path: [],
      provided,
    });
    const out = engine.evaluate(doc, scope({ hero_name: 'Aria', start_level: 3, attack_die: '1d8' })) as Record<
      string,
      Record<string, unknown>
    >;
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
    expect(() => engine.evaluateDoc('params.yaml', { start_level: 'high' })).toThrow(
      'param type mismatch: start_level expected integer, got string',
    );
    expect(() => engine.evaluateDoc('params.yaml', { hero_name: 42 })).toThrow(
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
    const scope = (provided?: Record<string, unknown>): EvalRoots => ({
      doc,
      actor: doc,
      app: engine.appRoot,
      current: doc,
      path: [],
      provided,
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
    const over = engine.evaluate(doc, scope({ greeting: 'yo', retries: 5 })) as Record<string, Record<string, unknown>>;
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
    const out = engine.evaluateDoc('p.yaml', { xp: 6500 }) as { double?: unknown };
    expect(out.double).toBe(13000);
    const missing = engine.evaluateDoc('p.yaml', {}) as { double?: unknown };
    expect(missing.double).toBe(0);
  });

  it('dereferences defaults without provided values', () => {
    const engine = new GoblinEngine('.');
    const doc = {
      xp: { ':param': true, ':type': 'integer', ':default': 0 },
      level: '@.xp',
    };
    engine.docs.set('p.yaml', doc);
    const out = engine.evaluateDoc('p.yaml', {}) as { level?: unknown };
    expect(out.level).toBe(0);
  });

  it('refuses .value reads on :param records but keeps data slots', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('param.yaml', {
      xp: { ':param': true, ':type': 'integer' },
      alias: '@.xp.value',
    });
    expect(() => engine.evaluateDoc('param.yaml', { xp: 1 })).toThrow('unresolvable reference: @.xp.value');
    engine.docs.set('data.yaml', { hp: { value: 3, max: 5 }, alias: '@.hp.value' });
    const out = engine.evaluateDoc('data.yaml', {}) as { alias?: unknown };
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
    const out = engine.evaluateDoc('params.yaml', { hero_name: 'Aria' }) as Record<string, Record<string, unknown>>;
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

    const empty = engine.resolve('params.yaml', {});
    expect(empty).toEqual({
      query: [
        { path: 'hero_name', label: 'Hero Name', doc: 'The hero name.', type: 'string' },
        { path: 'start_level', doc: 'Starting level.', type: 'integer' },
        { path: 'attack_die', type: 'die' },
        { path: 'details.title' },
      ],
    });

    const partial = engine.resolve('params.yaml', { hero_name: 'Aria' });
    expect(partial).toEqual({
      query: [
        { path: 'start_level', doc: 'Starting level.', type: 'integer' },
        { path: 'attack_die', type: 'die' },
        { path: 'details.title' },
      ],
    });

    const full = engine.resolve('params.yaml', {
      hero_name: 'Aria',
      start_level: 3,
      attack_die: '1d8',
      'details.title': 'Kid',
    }) as { data: Record<string, unknown> };
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
    const scope = (provided?: Record<string, unknown>): EvalRoots => ({
      doc,
      actor: doc,
      app: engine.appRoot,
      current: doc,
      path: [],
      provided,
    });
    const filled = engine.evaluate(doc, scope({ tags: ['a', 'b'] })) as Record<string, Record<string, unknown>>;
    expect(filled.tags).toEqual({ ':doc': 'Tags.', ':param': true, ':type': 'array', ':value': ['a', 'b'] });
    const empty = engine.evaluate(doc, scope({ tags: [] })) as Record<string, Record<string, unknown>>;
    expect(empty.tags?.[':value']).toEqual([]);
    expect(() => engine.evaluate(doc, scope({ tags: 'nope' }))).toThrow(
      'param type mismatch: tags expected array, got string',
    );
  });

  it('resolve returns data for documents without params', () => {
    const { engine } = testEngine();
    const resolved = engine.resolve('main.yaml', {}) as { data: Record<string, unknown> };
    expect((resolved.data.abilities as Record<string, { modifier: number }>).strength?.modifier).toBe(2);
  });

  it('resolve honors overrides over derived and missing values', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('ov.yaml', {
      computed: '1 + 1',
      name: { ':doc': 'Your name.', ':param': true },
    });
    const resolved = engine.resolve('ov.yaml', {}, { computed: 99, 'brand.new': 1, name: 'Aria' }) as {
      data: Record<string, unknown>;
    };
    // An override is a change like any other: it prints with its event.
    expect(resolved.data).toEqual({
      computed: { ':value': 99, ':events': [{ ':set': '1 + 1' }, { ':source': 'override', ':set': 99 }] },
      brand: { new: { ':value': 1, ':events': [{ ':source': 'override', ':set': 1 }] } },
      name: {
        ':value': 'Aria',
        ':events': [{ ':set': { ':doc': 'Your name.', ':param': true } }, { ':source': 'override', ':set': 'Aria' }],
      },
    });
    expect(print(resolved.data)).toEqual({ computed: 99, brand: { new: 1 }, name: 'Aria' });
  });

  it('resolve keeps :type contracts on overridden params', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('ov.yaml', {
      level: { ':doc': 'Level.', ':param': true, ':type': 'integer' },
    });
    expect(() => engine.resolve('ov.yaml', {}, { level: 'high' })).toThrow(
      'param type mismatch: level expected integer, got string',
    );
  });

  it('enforces :options membership for scalar and array values', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('choice.yaml', {
      style: { ':param': true, ':type': 'string', ':options': ['archery', 'dueling'] },
      skills: { ':param': true, ':type': 'array', ':options': ['arcana', 'history'] },
    });
    const good = engine.evaluateDoc('choice.yaml', { style: 'dueling', skills: ['arcana'] }) as Record<
      string,
      Record<string, unknown>
    >;
    expect(good.style?.[':value']).toBe('dueling');
    expect(good.skills?.[':value']).toEqual(['arcana']);
    expect(() => engine.evaluateDoc('choice.yaml', { style: 'sneaky', skills: ['arcana'] })).toThrow(
      'param options mismatch: style expected one of ["archery", "dueling"], got "sneaky"',
    );
    expect(() => engine.evaluateDoc('choice.yaml', { style: 'dueling', skills: ['arcana', 'sneak'] })).toThrow(
      'param options mismatch: skills[1] expected one of ["arcana", "history"], got "sneak"',
    );
  });

  it('enforces :unique distinctness and :count length on arrays', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('skills.yaml', {
      trained: { ':param': true, ':type': 'array', ':options': ['a', 'b', 'c'], ':count': 2, ':unique': true },
    });
    const good = engine.evaluateDoc('skills.yaml', { trained: ['a', 'b'] }) as Record<string, Record<string, unknown>>;
    expect(good.trained?.[':value']).toEqual(['a', 'b']);
    expect(() => engine.evaluateDoc('skills.yaml', { trained: ['a', 'a'] })).toThrow(
      'param uniqueness mismatch: trained has duplicate item "a"',
    );
    expect(() => engine.evaluateDoc('skills.yaml', { trained: ['a'] })).toThrow(
      'param count mismatch: trained expected 2 items, got 1',
    );
    expect(() => engine.evaluateDoc('skills.yaml', { trained: ['a', 'b', 'c'] })).toThrow(
      'param count mismatch: trained expected 2 items, got 3',
    );
  });

  it('enforces :min/:max bounds inclusively, per item on arrays', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('bounds.yaml', {
      score: { ':param': true, ':type': 'integer', ':min': 8, ':max': 15 },
      rolls: { ':param': true, ':type': 'array', ':min': 1 },
    });
    const good = engine.evaluateDoc('bounds.yaml', { score: 8, rolls: [1, 6] }) as Record<
      string,
      Record<string, unknown>
    >;
    expect(good.score?.[':value']).toBe(8);
    expect(() => engine.evaluateDoc('bounds.yaml', { score: 16, rolls: [1] })).toThrow(
      'param range mismatch: score expected 8 to 15, got 16',
    );
    expect(() => engine.evaluateDoc('bounds.yaml', { score: 7, rolls: [1] })).toThrow(
      'param range mismatch: score expected 8 to 15, got 7',
    );
    expect(() => engine.evaluateDoc('bounds.yaml', { score: 10, rolls: [3, 0] })).toThrow(
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
    expect(() => engine.evaluateDoc('def.yaml', {})).toThrow(
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
    expect(() => engine.resolve('ov.yaml', {}, { trained: ['z'] })).toThrow(
      'param options mismatch: trained[0] expected one of ["a", "b"], got "z"',
    );
    expect(() => engine.resolve('ov.yaml', {}, { trained: ['a', 'b'] })).toThrow(
      'param count mismatch: trained expected 1 items, got 2',
    );
    const ok = engine.resolve('ov.yaml', {}, { trained: ['a'] }) as { data: Record<string, unknown> };
    expect(fieldValue(ok.data.trained)).toEqual(['a']);
  });
});
