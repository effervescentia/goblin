import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// End-to-end over the real 5e/ documents (parsed by Bun, so shelled out like
// src/examples.test.ts): XP thresholds, class adoption at the derived level,
// choices, and progression.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function cli(entry: string, ...extra: string[]): unknown {
  const out = execFileSync('bun', ['src/cli.ts', entry, '--compact', ...extra], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

/** Run the CLI expecting failure; returns stderr for message assertions. */
function cliFails(entry: string, ...extra: string[]): string {
  try {
    cli(entry, ...extra);
  } catch (err) {
    return String((err as { stderr?: unknown }).stderr ?? err);
  }
  throw new Error(`expected CLI to fail: ${entry} ${extra.join(' ')}`);
}

const script = `
  import { GoblinEngine } from './src/engine.ts';
  import { RecordNode } from './src/nodes/record.ts';
  const e = new GoblinEngine('5e');
  // Fields a patch wrote print as { :value, :events } — read the value.
  const val = (v) => (v && typeof v === 'object' && ':value' in v ? v[':value'] : v);
  // Single load: engine discovery follows $tmpl refs (main → character,
  // fighter, levels) automatically.
  await e.loadFile('main.yaml');

  const baseMissing = e.missingParams('character.yaml').map((m) => m.path).sort();

  const BOUGHT = {
    ability_method: 'point_buy',
    'abilities.strength.bought': 7,
    'abilities.dexterity.bought': 6,
    'abilities.constitution.bought': 5,
    'abilities.intelligence.bought': 2,
    'abilities.wisdom.bought': 2,
    'abilities.charisma.bought': 0,
  };
  const fresh = () => structuredClone(e.docs.get('character.yaml'));
  const scopeOf = (actor, provided) => ({ doc: actor, actor, app: e.appRoot, current: actor, provided });
  const baseProvided = (xp) => ({
    name: 'X',
    xp,
    'features.fighting_style': 'defense',
    'features.martial_archetype': 'champion',
    'skills.trained': ['athletics', 'perception'],
    // The level-4 feature's pick: the same ability twice is +2.
    'improvements.level_4': ['strength', 'strength'],
    // Point buy: the classic 15/14/13/10/10/8 spread, 25 of 27 points.
    ...BOUGHT,
  });

  // Derive the level from XP, then adopt the fighter: omitted maxLevel
  // applies exactly the earned levels automatically.
  const run = (xp) => {
    const a = fresh();
    const provided = baseProvided(xp);
    const lv = e.evaluate(a, scopeOf(a, provided)).level;
    e.apply(a, 'point_buy.yaml');
    e.apply(a, 'fighter.yaml');
    return { lv, v: e.evaluate(a, scopeOf(a, provided)) };
  };

  const a3 = fresh();
  e.evaluate(a3, scopeOf(a3, { name: 'X', xp: 900, ability_method: 'point_buy' }));
  e.apply(a3, 'point_buy.yaml');
  e.apply(a3, 'fighter.yaml');
  const mergedMissing = RecordNode.collectParams(a3).map((m) => m.path).sort();

  const levels = {};
  for (const xp of [0, 299, 300, 899, 900, 2699, 2700, 6499, 6500, 354999, 355000, 999999]) {
    levels[xp] = run(xp).lv;
  }
  levels.none = (() => {
    const a = fresh();
    return e.evaluate(a, scopeOf(a, { name: 'X' })).level;
  })();

  const r = (xp) => run(xp).v;
  const attacks = { 0: val(r(0).attacks), 6500: val(r(6500).attacks), 85000: val(r(85000).attacks), 355000: val(r(355000).attacks) };
  const prof = { 0: r(0).proficiency_bonus, 6500: r(6500).proficiency_bonus, 48000: r(48000).proficiency_bonus, 225000: r(225000).proficiency_bonus };
  const v5 = r(6500);
  const sw = v5.actions.second_wind.heal();

  // Resolve envelope for a satisfied fighter.
  const a5 = fresh();
  const provided5 = { ...baseProvided(6500), name: 'Bram' };
  e.evaluate(a5, scopeOf(a5, provided5));
  e.apply(a5, 'point_buy.yaml');
  e.apply(a5, 'fighter.yaml');
  e.docs.set('fighter5.yaml', a5);
  const resolved = e.resolve('fighter5.yaml', provided5);

  console.log(JSON.stringify({
    baseMissing,
    mergedMissing,
    ac: val(v5.armor_class),
    strength: val(v5.abilities.strength.base),
    strengthModifier: val(v5.abilities.strength.modifier),
    dexterity: val(v5.abilities.dexterity.base),
    hp: { value: val(v5.hit_points.current), max: val(v5.hit_points.max) },
    trained: v5.skills.trained[':value'],
    surge: { value: val(v5.resources.action_surge.current), max: val(v5.resources.action_surge.max) },
    swMin: sw >= 6,
    swMax: sw <= 15,
    levels,
    attacks,
    prof,
    resolvedKeys: Object.keys(resolved),
    resolvedAttacks: val(resolved.data.attacks),
    resolvedLevel: val(resolved.data.level),
  }));
`;

// The classic 15/14/13/10/10/8 spread: 25 of the 27 points.
const BOUGHT = [
  '--param',
  'ability_method=point_buy',
  '--param',
  'abilities.strength.bought=7',
  '--param',
  'abilities.dexterity.bought=6',
  '--param',
  'abilities.constitution.bought=5',
  '--param',
  'abilities.intelligence.bought=2',
  '--param',
  'abilities.wisdom.bought=2',
  '--param',
  'abilities.charisma.bought=0',
];

describe('5e', () => {
  it('levels a fighter from 1 to 20 on XP', () => {
    const out = execFileSync('bun', ['-e', script], { cwd: root, encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual({
      // Each ability's choice waits on the method that adds it.
      baseMissing: ['ability_method', 'name'],
      mergedMissing: [
        'abilities.charisma.bought',
        'abilities.constitution.bought',
        'abilities.dexterity.bought',
        'abilities.intelligence.bought',
        'abilities.strength.bought',
        'abilities.wisdom.bought',
        'ability_method',
        'features.fighting_style',
        'features.martial_archetype',
        'name',
        'skills.trained',
      ],
      ac: 12,
      strength: 17,
      strengthModifier: 3,
      dexterity: 14,
      hp: { value: 11, max: 11 },
      trained: ['athletics', 'perception'],
      surge: { value: 1, max: 1 },
      swMin: true,
      swMax: true,
      levels: {
        0: 1,
        299: 1,
        300: 2,
        899: 2,
        900: 3,
        2699: 3,
        2700: 4,
        6499: 4,
        6500: 5,
        354999: 19,
        355000: 20,
        999999: 20,
        none: 1,
      },
      attacks: { 0: 1, 6500: 2, 85000: 3, 355000: 4 },
      prof: { 0: 2, 6500: 3, 48000: 4, 225000: 6 },
      resolvedKeys: ['data'],
      resolvedAttacks: 2,
      resolvedLevel: 5,
    });
  });

  it('serves the composed fighter through the root entry', () => {
    // The method comes first: no ability asks for a score until it is chosen.
    const query = cli('5e/main.yaml') as { query: Array<{ path: string }> };
    expect(query.query.map((param) => param.path).sort()).toEqual([
      'ability_method',
      'features.fighting_style',
      'name',
      'skills.trained',
    ]);

    const data = cli(
      '5e/main.yaml',
      ...BOUGHT,
      '--param',
      'name=Aria',
      '--param',
      'xp=6500',
      '--param',
      'features.fighting_style=dueling',
      '--param',
      'features.martial_archetype=champion',
      '--param',
      'skills.trained=["athletics","perception"]',
      '--param',
      'improvements.level_4=["strength","strength"]',
    ) as {
      data: {
        level: number;
        attacks: Record<string, unknown>;
        armor_class: number;
        features: Record<string, unknown>;
      };
    };
    expect(data.data.level).toBe(5);
    expect(data.data.armor_class).toBe(12); // 10 + dex 14
    // A patched field carries the writes that produced it, in order — here
    // the Extra Attack feature adding to the character's single attack.
    expect(data.data.attacks).toEqual({
      ':value': 2,
      ':events': [
        { ':source': 'character.yaml', ':set': 1 },
        { ':source': 'fighter.yaml', ':add': '1 + (@.level >= 11) + (@.level >= 20)' },
      ],
    });
    // A `+key` addition is itself a change: the feature records who added it.
    expect(data.data.features.extra_attack).toEqual({
      ':label': 'Extra Attack',
      ':doc': 'Strike twice whenever you take the Attack action.',
      ':events': [{ ':source': 'fighter.yaml', ':add': 'extra_attack' }],
    });
    expect(data.data.features.fighting_style).toEqual({
      ':label': 'Fighting Style',
      ':doc': 'Pick the combat style you trained in.',
      ':param': true,
      ':type': 'string',
      ':options': ['archery', 'defense', 'dueling', 'great_weapon_fighting', 'protection', 'two_weapon_fighting'],
      ':value': 'dueling',
      ':events': [{ ':source': 'fighter.yaml', ':add': 'fighting_style' }],
    });
  });

  it('improves abilities from the level-4 choice: twice for +2, split for +1 each', () => {
    const args = (picks: string): [string, ...string[]] => [
      '5e/main.yaml',
      '--strip-metadata',
      ...BOUGHT,
      '--param',
      'name=Aria',
      '--param',
      'xp=6500',
      '--param',
      'features.fighting_style=dueling',
      '--param',
      'features.martial_archetype=champion',
      '--param',
      'skills.trained=["athletics","perception"]',
      '--param',
      `improvements.level_4=${picks}`,
    ];
    const sheet = (picks: string) =>
      cli(...args(picks)) as {
        data: { abilities: Record<string, { base: number; modifier: number }>; armor_class: number };
      };

    // Bought 15/14/13: the improvement stacks on the point-buy score.
    const doubled = sheet('["strength","strength"]').data;
    expect(doubled.abilities.strength).toEqual({ bought: 7, start: 15, base: 17, modifier: 3 });
    expect(doubled.abilities.dexterity).toEqual({ bought: 6, start: 14, base: 14, modifier: 2 });

    const split = sheet('["dexterity","constitution"]').data;
    expect(split.abilities.dexterity).toEqual({ bought: 6, start: 14, base: 15, modifier: 2 });
    expect(split.abilities.constitution).toEqual({ bought: 5, start: 13, base: 14, modifier: 2 });
    expect(split.abilities.strength).toEqual({ bought: 7, start: 15, base: 15, modifier: 2 });

    // A pick outside the six abilities is refused.
    expect(cliFails(...args('["luck","luck"]'))).toContain(
      'param options mismatch: improvements.level_4[0] expected one of',
    );
    // Exactly two picks: no more, no fewer.
    expect(cliFails(...args('["strength"]'))).toContain(
      'param count mismatch: improvements.level_4 expected 2 items, got 1',
    );
  });

  it('spends point buy within its budget, and refuses more', () => {
    const spread = (...scores: number[]): string[] => [
      '--param',
      'ability_method=point_buy',
      ...['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'].flatMap((ability, i) => [
        '--param',
        `abilities.${ability}.bought=${(scores[i] ?? 8) - 8}`,
      ]),
    ];
    const rest = [
      '--param',
      'name=Aria',
      '--param',
      'xp=0',
      '--param',
      'features.fighting_style=dueling',
      '--param',
      'skills.trained=["athletics","perception"]',
    ];

    // 15/14/13/10/10/8 costs 9+7+5+2+2+0 = 25 of 27.
    const data = cli('5e/main.yaml', '--strip-metadata', ...spread(15, 14, 13, 10, 10, 8), ...rest) as {
      data: { point_buy: { budget: number; spent: number }; abilities: Record<string, { modifier: number }> };
    };
    expect(data.data.point_buy).toEqual({ budget: 27, spent: 25 });
    expect(data.data.abilities.strength?.modifier).toBe(2);
    expect(data.data.abilities.charisma?.modifier).toBe(-1);

    // Every point spent exactly: 15/15/15/8/8/8 is 27.
    const exact = cli('5e/main.yaml', '--strip-metadata', ...spread(15, 15, 15, 8, 8, 8), ...rest) as {
      data: { point_buy: { spent: number } };
    };
    expect(exact.data.point_buy.spent).toBe(27);

    // One point over the budget fails the rule.
    expect(cli('5e/main.yaml', ...spread(15, 15, 15, 9, 8, 8), ...rest)).toEqual({ errors: ['.spent <= .budget'] });
    // A score off the point-buy ladder is refused before any budget check.
    expect(cliFails('5e/main.yaml', ...spread(16, 8, 8, 8, 8, 8), ...rest)).toContain(
      'param range mismatch: abilities.strength.bought expected 0 to 7, got 8',
    );
  });

  it('assigns the standard array instead of point buy, each score once', () => {
    const rest = [
      '--param',
      'name=Aria',
      '--param',
      'xp=0',
      '--param',
      'ability_method=standard_array',
      '--param',
      'features.fighting_style=dueling',
      '--param',
      'skills.trained=["athletics","perception"]',
    ];
    const assign = (...scores: number[]): string[] =>
      ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'].flatMap((ability, i) => [
        '--param',
        `abilities.${ability}.assigned=${scores[i]}`,
      ]);

    // The chosen method swaps in its own choice per ability.
    const query = cli('5e/main.yaml', ...rest) as { query: Array<{ path: string; options?: unknown[] }> };
    expect(query.query.map((param) => param.path)).toEqual([
      'abilities.strength.assigned',
      'abilities.dexterity.assigned',
      'abilities.constitution.assigned',
      'abilities.intelligence.assigned',
      'abilities.wisdom.assigned',
      'abilities.charisma.assigned',
    ]);
    expect(query.query[0]?.options).toEqual([15, 14, 13, 12, 10, 8]);

    const data = cli('5e/main.yaml', '--strip-metadata', ...assign(8, 15, 14, 10, 13, 12), ...rest) as {
      data: Record<string, unknown> & { abilities: Record<string, { base: number; modifier: number }> };
    };
    expect(data.data.abilities.dexterity).toEqual({ assigned: 15, start: 15, base: 15, modifier: 2 });
    expect(data.data.abilities.strength).toEqual({ assigned: 8, start: 8, base: 8, modifier: -1 });
    expect(data.data.armor_class).toBe(12);
    // Point buy never applied: no budget, no bought scores.
    expect(data.data.point_buy).toBeUndefined();
    expect(data.data.standard_array).toEqual({ assigned: [8, 15, 14, 10, 13, 12] });

    // Every score once: a repeat leaves another unused, and both rules say so.
    expect(cli('5e/main.yaml', ...assign(15, 15, 14, 10, 13, 12), ...rest)).toEqual({
      errors: ['$lib.list.count(.assigned, 15) == 1', '$lib.list.count(.assigned, 8) == 1'],
    });
    // A score off the array is refused outright.
    expect(cliFails('5e/main.yaml', ...assign(16, 15, 14, 10, 13, 12), ...rest)).toContain(
      'param options mismatch: abilities.strength.assigned expected one of [15, 14, 13, 12, 10, 8], got 16',
    );
  });

  it('names each choice from the definition it was called with', () => {
    const query = cli(
      '5e/main.yaml',
      '--param',
      'name=Aria',
      '--param',
      'xp=6500',
      '--param',
      'ability_method=point_buy',
    ) as {
      query: Array<{ path: string; label?: string }>;
    };
    const labels = Object.fromEntries(query.query.map((param) => [param.path, param.label]));
    expect(labels['abilities.strength.bought']).toBe('Strength');
    expect(labels['abilities.charisma.bought']).toBe('Charisma');
    expect(labels['improvements.level_4']).toBe('Ability Score Improvement (level 4)');
  });

  it('rejects a fighting style outside the options', () => {
    expect(
      cliFails(
        '5e/main.yaml',
        ...BOUGHT,
        '--param',
        'name=Aria',
        '--param',
        'xp=6500',
        '--param',
        'features.fighting_style=kung_fu',
        '--param',
        'features.martial_archetype=champion',
        '--param',
        'skills.trained=["athletics","perception"]',
        '--param',
        'improvements.level_4=["strength","strength"]',
      ),
    ).toContain(
      'param options mismatch: features.fighting_style expected one of ["archery", "defense", "dueling", "great_weapon_fighting", "protection", "two_weapon_fighting"], got "kung_fu"',
    );
  });

  it('rejects skill choices outside the options, duplicates, or wrong count', () => {
    const base: [string, ...string[]] = [
      '5e/main.yaml',
      ...BOUGHT,
      '--param',
      'name=Aria',
      '--param',
      'xp=6500',
      '--param',
      'features.fighting_style=dueling',
      '--param',
      'features.martial_archetype=champion',
      '--param',
      'improvements.level_4=["strength","strength"]',
    ];
    expect(cliFails(...base, '--param', 'skills.trained=["athletics","sneak"]')).toContain(
      'param options mismatch: skills.trained[1] expected one of ["acrobatics", "animal_handling", "athletics", "history", "insight", "intimidation", "perception", "survival"], got "sneak"',
    );
    expect(cliFails(...base, '--param', 'skills.trained=["athletics","athletics"]')).toContain(
      'param uniqueness mismatch: skills.trained has duplicate item "athletics"',
    );
    expect(cliFails(...base, '--param', 'skills.trained=["athletics"]')).toContain(
      'param count mismatch: skills.trained expected 2 items, got 1',
    );
  });

  it('overrides level explicitly without XP', () => {
    const query = cli('5e/main.yaml', ...BOUGHT, '--set', 'level=5', '--param', 'name=Aria') as {
      query: Array<{ path: string }>;
    };
    // Adoption follows the overridden level (L5 features apply); xp has a
    // default so it is not asked.
    expect(query.query.map((param) => param.path).sort()).toEqual([
      'features.fighting_style',
      'features.martial_archetype',
      'improvements.level_4',
      'skills.trained',
    ]);

    const data = cli(
      '5e/main.yaml',
      ...BOUGHT,
      '--set',
      'level=5',
      '--param',
      'name=Aria',
      '--param',
      'xp=0',
      '--param',
      'features.fighting_style=dueling',
      '--param',
      'features.martial_archetype=champion',
      '--param',
      'skills.trained=["athletics","perception"]',
      '--param',
      'improvements.level_4=["strength","strength"]',
    ) as { data: { level: Record<string, unknown>; attacks: Record<string, unknown> } };
    expect(data.data.attacks[':value']).toBe(2);
    // `--set` beats the derivation it replaced, and says so.
    expect(data.data.level).toEqual({
      ':value': 5,
      ':events': [
        { ':source': 'character.yaml', ':set': '#.levels.level_for(@.xp)' },
        { ':source': 'override', ':set': 5 },
      ],
    });
  });
});
