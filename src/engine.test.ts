import { describe, expect, it } from 'vitest';
import { GoblinEngine } from './engine';
import {
  checkParamType,
  collectParams,
  Die,
  detectDeps,
  type EvalRoots,
  isDieLiteral,
  isExpressionString,
  parseDie,
  parseRef,
  serialize,
  tagFunction,
} from './utils';

function testEngine() {
  const engine = new GoblinEngine('.');
  const doc = {
    utils: {
      'ability_modifier(x)': '$lib.math.floor((x - 10) / 2)',
    },
    abilities: {
      strength: { base: 15, modifier: '#.utils.ability_modifier(.base)' },
      dexterity: { base: 14, modifier: '#.utils.ability_modifier(.base)' },
      wisdom: { base: 12, modifier: '#.utils.ability_modifier(.base)' },
    },
    armor_class: '10 + #.abilities.dexterity.modifier',
    initiative: {
      base: '#.abilities.dexterity.modifier',
      'roll()': '1d20 + .base',
    },
    hit_die: 'd6',
    hit_points: {
      '!validate': ['.value >= 0', '.value <= .max'],
      value: 3,
      max: 5,
    },
    rest: {
      'short()': '#.hit_points.value = $lib.math.min(#.hit_points.value + #.hit_die, #.hit_points.max)',
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
    expect(parseRef('#.utils.ability_modifier')).toEqual({ root: '#', path: ['utils', 'ability_modifier'] });
    expect(parseRef('$.abilities.dexterity')).toEqual({ root: '$', path: ['abilities', 'dexterity'] });
    expect(parseRef('@.features')).toEqual({ root: '@', path: ['features'] });
    expect(parseRef('.base')).toEqual({ root: '.', path: ['base'] });
  });

  it('handles bare sigils and missing dots', () => {
    expect(parseRef('$')).toEqual({ root: '$', path: [] });
    expect(parseRef('@')).toEqual({ root: '@', path: [] });
    expect(parseRef('$math.min')).toEqual({ root: '$', path: ['math', 'min'] });
  });
});

describe('dice', () => {
  it('detects die literals', () => {
    expect(isDieLiteral('d6')).toBe(true);
    expect(isDieLiteral('2d6')).toBe(true);
    expect(isDieLiteral('bonus_action')).toBe(false);
    expect(isDieLiteral('1d20 + .base')).toBe(false);
  });

  it('parses dice and preserves the label', () => {
    expect(parseDie('1d6')).toEqual(new Die(1, 6, '1d6'));
    expect(String(parseDie('d20'))).toBe('d20');
    expect(parseDie('nope')).toBeNull();
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
});

describe('expressions', () => {
  it('detects expression strings', () => {
    expect(isExpressionString('#.utils.ability_modifier(.base)')).toBe(true);
    expect(isExpressionString('10 + $.abilities.dexterity.modifier')).toBe(true);
    expect(isExpressionString('bonus_action')).toBe(false);
    expect(isExpressionString('Player')).toBe(false);
  });

  it('evaluates arithmetic and references', () => {
    const { engine, scope } = testEngine();
    expect(engine.evalExpr('10 + #.abilities.dexterity.modifier', scope)).toBe(12);
    expect(engine.evalExpr('#.utils.ability_modifier(15)', scope)).toBe(2);
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

  it('merges yaml helpers into $lib over the natives', () => {
    const engine = new GoblinEngine('.');
    engine.mergeLib({ 'double(x)': 'x * 2' });
    const scope = { doc: {}, actor: {}, app: engine.appRoot, current: {}, path: [] };
    expect(engine.evalExpr('$lib.double(21)', scope)).toBe(42);
    expect(engine.evalExpr('$lib.math.floor(2.9)', scope)).toBe(2);
  });

  it('throws on unresolvable references', () => {
    const { engine, scope } = testEngine();
    expect(() => engine.evalExpr('#.missing.thing', scope)).toThrow('unresolvable reference');
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
    expect((appView.hit_points as { value: number }).value).toBeGreaterThanOrEqual(3);
    expect((appView.hit_points as { value: number }).value).toBeLessThanOrEqual(5);
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
    expect((out.monk as { martial_arts_die: Die }).martial_arts_die.toString()).toBe('1d6');
    expect(out.features).toHaveProperty('martial_arts');
    expect(out.features).toHaveProperty('unarmored_defense');
    expect((out.features as Record<string, { ':doc': string }>)['martial_arts']?.[':doc']).toBe('martial arts mastery');
    expect(out.armor_class).toBe(12);
    expect((out.proficiencies as { weapon: string[] }).weapon).toEqual(['simple_melee', 'light_martial_melee']);
    expect(String((out.actions as { unarmed_strike: { die: unknown } }).unarmed_strike.die)).toBe('d4');
  });

  it('gates content on $if conditions with no residue', () => {
    const l1 = appliedEngine(1).out;
    expect(l1.features).not.toHaveProperty('monks_focus');
    expect(String((l1.actions as { unarmed_strike: { die: unknown } }).unarmed_strike.die)).toBe('d4');
    const l2 = appliedEngine(2).out;
    expect(l2.features).toHaveProperty('monks_focus');
    const strike = (l2.actions as { unarmed_strike: { die: unknown; type: unknown } }).unarmed_strike;
    expect(String(strike.die)).toBe('1d8');
    expect(strike.type).toBe('bonus_action');
  });

  it('respects a false $if condition', () => {
    const { engine, doc } = testEngine();
    const actorRaw = structuredClone(doc) as Record<string, unknown>;
    actorRaw['features'] = {};
    engine.docs.set('gated.yaml', {
      '@.features': {
        '+sneak_attack': {
          $if: '#.hit_points.value > #.hit_points.max',
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
});

describe('validate', () => {
  it('passes valid nodes and reports failures', () => {
    const { engine } = testEngine();
    const out = engine.evaluateDoc('main.yaml');
    expect(engine.validate(out)).toEqual([]);

    const bad = { hit_points: { '!validate': ['.value >= 0'], value: -2 } };
    expect(engine.validate(bad)).toEqual(['.value >= 0']);
  });
});

describe('serialize', () => {
  it('converts dice and functions to JSON-friendly values', () => {
    expect(serialize(new Die(1, 6, '1d6'))).toBe('1d6');
    expect(serialize(function roll() {})).toBe('[fn roll()]');
    expect(serialize({ a: [new Die(1, 4, 'd4')] })).toEqual({ a: ['d4'] });
  });

  it('prints tagged functions as source/dependencies objects', () => {
    const { engine } = testEngine();
    const out = engine.evaluateDoc('main.yaml') as Record<string, any>;
    expect(serialize(out.utils.ability_modifier)).toEqual({
      $type: 'function',
      params: ['x'],
      source: '$lib.math.floor((x - 10) / 2)',
      dependencies: ['$.lib.math.floor'],
    });
    expect(serialize((out.initiative as { roll: unknown }).roll)).toEqual({
      $type: 'function',
      params: [],
      source: '1d20 + .base',
      dependencies: ['.base'],
    });
    expect(serialize((out.rest as { short: unknown }).short)).toEqual({
      $type: 'function',
      params: [],
      source: '#.hit_points.value = $lib.math.min(#.hit_points.value + #.hit_die, #.hit_points.max)',
      dependencies: ['#.hit_points.value', '$.lib.math.min', '#.hit_die', '#.hit_points.max'],
    });
  });
});

describe('detectDeps', () => {
  it('collects refs in order, deduplicated', () => {
    expect(detectDeps('#.utils.ability_modifier(.base)')).toEqual(['#.utils.ability_modifier', '.base']);
    expect(detectDeps('$.a + $.a + $.b')).toEqual(['$.a', '$.b']);
  });

  it('ignores string literals, dice, and dot-less sigils normalized', () => {
    expect(detectDeps("$tmpl('a.yaml')")).toEqual(['$.tmpl']);
    expect(detectDeps('$math.max(3, 5)')).toEqual(['$.math.max']);
    expect(detectDeps('1d20 + 2')).toEqual([]);
  });

  it('trims whitespace from printed source', () => {
    const fn = tagFunction(() => 1, { name: 'f', params: [], source: '  1d20 + 2\n', deps: [] });
    expect(serialize(fn)).toEqual({ $type: 'function', params: [], source: '1d20 + 2', dependencies: [] });
  });
});

describe('parameters', () => {
  const doc = {
    hero_name: { ':doc': 'The hero name.', ':param': true, ':type': 'string' },
    level: { ':doc': 'Starting level.', ':param': 'start_level', ':type': 'integer' },
    attack_die: { ':param': true, ':type': 'die' },
    details: { title: { ':param': true } },
    hit_points: { value: 10, max: 10 },
  };

  it('collects missing params with paths, docs, and types', () => {
    expect(collectParams(doc)).toEqual([
      { path: 'hero_name', doc: 'The hero name.', type: 'string' },
      { path: 'start_level', doc: 'Starting level.', type: 'integer' },
      { path: 'attack_die', type: 'die' },
      { path: 'details.title' },
    ]);
  });

  it('rejects unknown param types', () => {
    expect(() => collectParams({ x: { ':param': true, ':type': 'spell' } })).toThrow(
      'unknown param type: spell (at x)',
    );
    expect(() => checkParamType('spell', 'x', 'x')).toThrow('unknown param type');
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
      { value: unknown }
    >;
    expect(out.hero_name?.value).toBe('Aria');
    expect(out.level?.value).toBe(3);
    expect(out.attack_die?.value).toBeInstanceOf(Die);
    expect((out.details as unknown as Record<string, { value: unknown }>).title?.value).toBeNull();
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

  it('exposes missing params for loaded documents', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('params.yaml', doc);
    expect(engine.missingParams('params.yaml')).toEqual([
      { path: 'hero_name', doc: 'The hero name.', type: 'string' },
      { path: 'start_level', doc: 'Starting level.', type: 'integer' },
      { path: 'attack_die', type: 'die' },
      { path: 'details.title' },
    ]);
    const out = engine.evaluateDoc('params.yaml', { hero_name: 'Aria' }) as Record<string, { value: unknown }>;
    expect(out.hero_name?.value).toBe('Aria');
    expect(out.level?.value).toBeNull();
  });

  it('resolves to data when satisfied, query with only outstanding params when not', () => {
    const engine = new GoblinEngine('.');
    engine.docs.set('params.yaml', doc);

    const empty = engine.resolve('params.yaml', {});
    expect(empty).toEqual({
      query: [
        { path: 'hero_name', doc: 'The hero name.', type: 'string' },
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
    }) as { data: Record<string, { value: unknown }> };
    expect(full.data.hero_name?.value).toBe('Aria');
    expect(full.data.level?.value).toBe(3);
    expect(full.data.attack_die?.value).toBe('1d8');
    expect((full.data.details as unknown as Record<string, { value: unknown }>).title?.value).toBe('Kid');
  });

  it('validates array parameters', () => {
    const engine = new GoblinEngine('.');
    const doc = { tags: { ':doc': 'Tags.', ':param': true, ':type': 'array' } };
    expect(collectParams(doc)).toEqual([{ path: 'tags', doc: 'Tags.', type: 'array' }]);
    const scope = (provided?: Record<string, unknown>): EvalRoots => ({
      doc,
      actor: doc,
      app: engine.appRoot,
      current: doc,
      path: [],
      provided,
    });
    const filled = engine.evaluate(doc, scope({ tags: ['a', 'b'] })) as Record<string, { value: unknown }>;
    expect(filled.tags?.value).toEqual(['a', 'b']);
    const empty = engine.evaluate(doc, scope({ tags: [] })) as Record<string, { value: unknown }>;
    expect(empty.tags?.value).toEqual([]);
    expect(() => engine.evaluate(doc, scope({ tags: 'nope' }))).toThrow(
      'param type mismatch: tags expected array, got string',
    );
  });

  it('resolve returns data for documents without params', () => {
    const { engine } = testEngine();
    const resolved = engine.resolve('main.yaml', {}) as { data: Record<string, unknown> };
    expect((resolved.data.abilities as Record<string, { modifier: number }>).strength?.modifier).toBe(2);
  });
});
