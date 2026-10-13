import { describe, expect, it } from 'vitest';
import {
  Die,
  type EvalRoots,
  GoblinEngine,
  isDieLiteral,
  isExpressionString,
  parseDie,
  parseRef,
  serialize,
} from './engine';

function testEngine() {
  const engine = new GoblinEngine('.');
  const doc = {
    utils: {
      'ability_modifier(x)': '$.math.floor((x - 10) / 2)',
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
      'short()': '#.hit_points.value = $.math.min(#.hit_points.value + #.hit_die, #.hit_points.max)',
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

  it('supports the math stdlib with and without a dot', () => {
    const { engine, scope } = testEngine();
    expect(engine.evalExpr('$.math.min(3, 5)', scope)).toBe(3);
    expect(engine.evalExpr('$math.max(3, 5)', scope)).toBe(5);
    expect(engine.evalExpr('#.math.floor(2.9)', scope)).toBe(2);
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
  function appliedEngine(maxLevel = 1) {
    const { engine, doc } = testEngine();
    const actorRaw = structuredClone(doc);
    engine.docs.set('monk.yaml', {
      $: 'Player',
      '@.monk': {},
      1: {
        '@.monk.martial_arts_die': '1d6',
        '@.features': {
          '+martial_arts': {
            ':doc': 'martial arts mastery',
            '@.proficiencies.weapon': ['+simple_melee', '+light_martial_melee'],
            $if: null,
            $then: {
              '@.actions.unarmed_strike': { '+die': '@.monk.martial_arts_die', '+type': 'bonus_action' },
            },
          },
          '+unarmored_defense': {
            $if: null,
            $then: { '@.armor_class': '10 + @.abilities.dexterity.modifier + @.abilities.wisdom.modifier' },
          },
        },
      },
      2: {
        '@.features': { '+monks_focus': {} },
      },
    });
    (actorRaw as Record<string, unknown>).proficiencies = { weapon: [] as string[] };
    (actorRaw as Record<string, unknown>).actions = { unarmed_strike: { die: 'd4', type: 'action' } };
    (actorRaw as Record<string, unknown>).features = {};
    engine.apply(actorRaw, 'monk.yaml', maxLevel);
    const scope: EvalRoots = { doc: actorRaw, actor: actorRaw, app: engine.appRoot, current: actorRaw };
    return { engine, out: engine.evaluate(actorRaw, scope) as Record<string, any> };
  }

  it('applies additions, path patches and $then blocks', () => {
    const { out } = appliedEngine();
    expect((out.monk as { martial_arts_die: Die }).martial_arts_die.toString()).toBe('1d6');
    expect(out.features).toHaveProperty('martial_arts');
    expect(out.features).toHaveProperty('unarmored_defense');
    expect((out.features as Record<string, { ':doc': string }>)['martial_arts']?.[':doc']).toBe('martial arts mastery');
    expect(out.armor_class).toBe(13);
    expect((out.proficiencies as { weapon: string[] }).weapon).toEqual(['simple_melee', 'light_martial_melee']);
  });

  it('gates numeric level blocks by maxLevel', () => {
    expect(appliedEngine(1).out.features).not.toHaveProperty('monks_focus');
    expect(appliedEngine(2).out.features).toHaveProperty('monks_focus');
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
    const out = engine.evaluate(actorRaw, scope) as Record<string, { never?: unknown }>;
    // The wrapper itself merges, but the $then content must not apply.
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
});
