import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TEMPLATES } from '../demo/sheet';
import { COMPANION_PARAMS } from './dnd5e.fixtures';

// End-to-end over the real 5e/ documents (parsed by Bun, so shelled out like
// src/examples.test.ts): XP thresholds, class adoption at the derived level,
// choices, and progression.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 5e/main.yaml nests its characters under `party`, each namespaced by its key:
// tests play `aria`, params are addressed by the namespace, and `cli` answers
// relative to it (bram and cora come fully chosen from the fixtures).
const PC = 'aria';

function run(entry: string, ...extra: string[]): unknown {
  const out = execFileSync('bun', ['src/cli/cli.ts', entry, '--compact', ...extra], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

/** Play the main entry's character: `--param`/`--set` keys gain the `PC`
 * prefix, and the `{ data }` / `{ query }` envelope comes back without it. */
function cli(entry: string, ...extra: string[]): unknown {
  const args = extra.map((arg, i) => (extra[i - 1] === '--param' || extra[i - 1] === '--set' ? `${PC}.${arg}` : arg));
  const state = run(entry, ...args, ...COMPANION_PARAMS) as {
    data?: { party: Record<string, unknown> };
    query?: Array<{ path: string }>;
  };
  if (state.data) return { data: state.data.party.aria };
  if (state.query) return { query: state.query.map((param) => ({ ...param, path: param.path.slice(PC.length + 1) })) };
  return state;
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
  import { GoblinEngine } from '@/core/engine';
  import { parameter } from '@/inputs';
  import { RecordNode } from '@/nodes/record';
  const e = new GoblinEngine('5e');
  const params = (values) => Object.entries(values).map(([path, value]) => parameter(path, value));
  // Fields a patch wrote print as { :value, :events } — read the value.
  const val = (v) => (v && typeof v === 'object' && ':value' in v ? v[':value'] : v);
  // Single load: engine discovery follows $tmpl refs (main → character,
  // fighter, levels) automatically.
  await e.loadFile('main.yaml');

  const baseMissing = e.missingParams('character.yaml').map((m) => m.path).sort();

  const BOUGHT = {
    class: 'fighter',
    species: 'dwarf',
    background: 'acolyte',
    'improvements.background': ['intelligence', 'wisdom', 'charisma'],
    ability_method: 'point_buy',
    'abilities.strength.bought': 7,
    'abilities.dexterity.bought': 6,
    'abilities.constitution.bought': 5,
    'abilities.intelligence.bought': 2,
    'abilities.wisdom.bought': 2,
    'abilities.charisma.bought': 0,
  };
  const fresh = () => structuredClone(e.docs.get('character.yaml'));
  const scopeOf = (actor, provided) => ({ doc: actor, actor, app: e.appRoot, current: actor, inputs: params(provided) });
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

  // The character document includes Fighter through its class mixin.
  const run = (xp) => {
    const a = fresh();
    const provided = baseProvided(xp);
    const lv = e.evaluate(a, scopeOf(a, provided)).level;
    return { lv, v: e.evaluate(a, scopeOf(a, provided)) };
  };

  const a3 = fresh();
  e.evaluate(a3, scopeOf(a3, { name: 'X', xp: 900, class: 'fighter', species: 'dwarf', ability_method: 'point_buy' }));
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

  // Second Wind: at level 5 there are three uses; after they run out it does nothing.
  const a6 = fresh();
  const provided6 = baseProvided(6500);
  e.evaluate(a6, scopeOf(a6, provided6));
  a6.hit_points.current = 1;
  const before = e.evaluate(a6, scopeOf(a6, provided6));
  before.actions.second_wind.use();
  const healed = e.evaluate(a6, scopeOf(a6, provided6));
  healed.actions.second_wind.use();
  e.evaluate(a6, scopeOf(a6, provided6)).actions.second_wind.use();
  const exhausted = e.evaluate(a6, scopeOf(a6, provided6));
  exhausted.actions.second_wind.use();
  const spent = e.evaluate(a6, scopeOf(a6, provided6));
  // Rests: a level-17 fighter with every use spent. A short rest refills the
  // \`short\` resources; Indomitable (\`long\`) waits for a long rest.
  const a17 = fresh();
  const provided17 = baseProvided(225000);
  e.evaluate(a17, scopeOf(a17, provided17));
  const uses = (v) => Object.fromEntries(Object.entries(v.resources).map(([k, r]) => [k, val(r.current)]));
  const fresh17 = uses(e.evaluate(a17, scopeOf(a17, provided17)));
  for (const key of Object.keys(a17.resources)) a17.resources[key].current = 0;
  e.evaluate(a17, scopeOf(a17, provided17)).rest.short();
  const afterShort = uses(e.evaluate(a17, scopeOf(a17, provided17)));
  e.evaluate(a17, scopeOf(a17, provided17)).rest.long();
  const afterLong = uses(e.evaluate(a17, scopeOf(a17, provided17)));
  const rests = { fresh17, afterShort, afterLong };

  const secondWind = {
    usesBefore: val(before.resources.second_wind.current),
    healedInRange: val(healed.hit_points.current) >= 1 + 6 && val(healed.hit_points.current) <= Math.min(1 + 15, val(healed.hit_points.max)),
    usesAfter: val(healed.resources.second_wind.current),
    unchangedWhenSpent: val(spent.hit_points.current) === val(exhausted.hit_points.current),
    usesSpent: val(spent.resources.second_wind.current),
  };

  // Resolve envelope for a satisfied fighter.
  const a5 = fresh();
  const provided5 = { ...baseProvided(6500), name: 'Bram' };
  e.evaluate(a5, scopeOf(a5, provided5));
  e.docs.set('fighter5.yaml', a5);
  const resolved = e.resolve('fighter5.yaml', params(provided5));

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
    secondWind,
    rests,
    levels,
    attacks,
    prof,
    resolvedKeys: Object.keys(resolved),
    resolvedAttacks: val(resolved.data.attacks),
    resolvedLevel: val(resolved.data.level),
  }));
`;

// Acolyte's +1s land on int/wis/cha, leaving every modifier these tests read as it was.
const BACKGROUND = [
  '--param',
  'background=acolyte',
  '--param',
  'improvements.background=["intelligence","wisdom","charisma"]',
];
const BACKGROUND_BONUS = (ability: string) => (['intelligence', 'wisdom', 'charisma'].includes(ability) ? 1 : 0);

// The classic 15/14/13/10/10/8 spread: 25 of the 27 points.
const BOUGHT = [
  '--param',
  'class=fighter',
  '--param',
  'species=dwarf',
  ...BACKGROUND,
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
      // Each ability's choice waits on its method; class features wait on the class.
      baseMissing: ['ability_method', 'background', 'class', 'name', 'species'],
      mergedMissing: [
        'abilities.charisma.bought',
        'abilities.constitution.bought',
        'abilities.dexterity.bought',
        'abilities.intelligence.bought',
        'abilities.strength.bought',
        'abilities.wisdom.bought',
        'ability_method',
        'background',
        'class',
        'features.fighting_style',
        'features.martial_archetype',
        'name',
        'skills.trained',
        'species',
      ],
      ac: 12,
      strength: 17,
      strengthModifier: 3,
      dexterity: 14,
      hp: { value: 11, max: 11 },
      trained: ['athletics', 'perception'],
      surge: { value: 1, max: 1 },
      secondWind: { usesBefore: 3, healedInRange: true, usesAfter: 2, unchangedWhenSpent: true, usesSpent: 0 },
      rests: {
        // Uses start full: Action Surge has 2 at 17, Indomitable 3.
        fresh17: { second_wind: 4, action_surge: 2, indomitable_points: 3 },
        afterShort: { second_wind: 4, action_surge: 2, indomitable_points: 0 },
        afterLong: { second_wind: 4, action_surge: 2, indomitable_points: 3 },
      },
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
    // Method, species and class come first: neither abilities nor class features ask until chosen.
    const query = cli('5e/main.yaml') as { query: Array<{ path: string }> };
    expect(query.query.map((param) => param.path).sort()).toEqual([
      'ability_method',
      'background',
      'class',
      'name',
      'species',
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
        armor_class: unknown;
        features: Record<string, unknown>;
      };
    };
    expect(data.data.level).toBe(5);
    // A labelled formula names its parts for the sheet: 10 + dex 14.
    expect(data.data.armor_class).toEqual({
      ':value': 12,
      ':formula': '10 + DEX',
      ':parts': [{ ':label': 'DEX', ':value': 2 }],
    });
    // A patched field carries the writes that produced it, in order — here
    // the Extra Attack feature adding to the character's single attack, each
    // write logged as the value it resolved to (level 5 adds 1).
    expect(data.data.attacks).toEqual({
      ':value': 2,
      ':events': [
        // Each write cites the key behind it: `attacks: 1`, then `'+@.attacks'`.
        { ':source': 'character.yaml', ':line': 51, ':column': 1, ':set': 1 },
        { ':source': 'class/fighter/fighter.yaml', ':line': 113, ':column': 5, ':add': 1 },
      ],
    });
    // A `+key` addition is itself a change: the feature records who added it.
    expect(data.data.features.extra_attack).toEqual({
      ':label': 'Extra Attack',
      ':doc': 'Strike twice whenever you take the Attack action.',
      ':events': [{ ':source': 'class/fighter/fighter.yaml', ':line': 109, ':column': 3, ':add': 'extra_attack' }],
    });
    expect(data.data.features.fighting_style).toEqual({
      ':label': 'Fighting Style',
      ':doc': 'Pick the combat style you trained in.',
      ':param': true,
      ':type': 'string',
      ':options': [
        'archery',
        'blind_fighting',
        'defense',
        'dueling',
        'great_weapon_fighting',
        'interception',
        'protection',
        'thrown_weapon_fighting',
        'two_weapon_fighting',
        'unarmed_fighting',
      ],
      ':value': 'dueling',
      ':events': [{ ':source': 'class/fighter/fighter.yaml', ':line': 34, ':column': 3, ':add': 'fighting_style' }],
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
      'class=fighter',
      '--param',
      'species=dwarf',
      ...BACKGROUND,
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
      data: { point_buy: { spent: number }; abilities: Record<string, { modifier: number }> };
    };
    // The private `_budget` stays out of stripped output.
    expect(data.data.point_buy).toEqual({ spent: 25 });
    expect(data.data.abilities.strength?.modifier).toBe(2);
    expect(data.data.abilities.charisma?.modifier).toBe(-1);

    // Every point spent exactly: 15/15/15/8/8/8 is 27.
    const exact = cli('5e/main.yaml', '--strip-metadata', ...spread(15, 15, 15, 8, 8, 8), ...rest) as {
      data: { point_buy: { spent: number } };
    };
    expect(exact.data.point_buy.spent).toBe(27);

    // One point over the budget fails the rule.
    expect(cli('5e/main.yaml', ...spread(15, 15, 15, 9, 8, 8), ...rest)).toEqual({ errors: ['.spent <= ._budget'] });
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
      'class=fighter',
      '--param',
      'species=dwarf',
      ...BACKGROUND,
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
    // Its pick list is private (`_assigned`): stripped output leaves nothing.
    expect(data.data.standard_array).toBeNull();
    const full = cli('5e/main.yaml', ...assign(8, 15, 14, 10, 13, 12), ...rest) as {
      data: { standard_array: { _assigned: { ':value': unknown } } };
    };
    expect(full.data.standard_array._assigned[':value']).toEqual([8, 15, 14, 10, 13, 12]);

    // Every score once: a repeat leaves another unused.
    expect(cli('5e/main.yaml', ...assign(15, 15, 14, 10, 13, 12), ...rest)).toEqual({
      errors: ['$lib.set.subset([15, 14, 13, 12, 10, 8], ._assigned)'],
    });
    // A score off the array is refused outright.
    expect(cliFails('5e/main.yaml', ...assign(16, 15, 14, 10, 13, 12), ...rest)).toContain(
      'param options mismatch: abilities.strength.assigned expected one of [15, 14, 13, 12, 10, 8], got 16',
    );
  });

  it('rolls 4d6 drop lowest for each ability, asking nothing', () => {
    const rest = [
      '--param',
      'name=Aria',
      '--param',
      'xp=0',
      '--param',
      'class=fighter',
      '--param',
      'species=dwarf',
      ...BACKGROUND,
      '--param',
      'ability_method=roll',
      '--param',
      'features.fighting_style=dueling',
      '--param',
      'skills.trained=["athletics","perception"]',
    ];
    for (let i = 0; i < 5; i++) {
      const data = cli('5e/main.yaml', '--strip-metadata', ...rest) as {
        data: Record<string, unknown> & {
          abilities: Record<string, { start: number; base: number; modifier: number }>;
          armor_class: number;
        };
      };
      for (const [name, ability] of Object.entries(data.data.abilities)) {
        expect(ability.start).toBeGreaterThanOrEqual(3);
        expect(ability.start).toBeLessThanOrEqual(18);
        // One roll per score: everything derived reads the same number, past the background's +1.
        expect(ability.base).toBe(ability.start + BACKGROUND_BONUS(name));
        expect(ability.modifier).toBe(Math.floor((ability.base - 10) / 2));
      }
      expect(data.data.armor_class).toBe(10 + (data.data.abilities.dexterity?.modifier ?? 0));
      expect(data.data.point_buy).toBeUndefined();
      expect(data.data.standard_array).toBeUndefined();
    }
  });

  it('rolls six scores and assigns each roll to an ability, each once', () => {
    const rest = [
      '--param',
      'name=Aria',
      '--param',
      'xp=0',
      '--param',
      'class=fighter',
      '--param',
      'species=dwarf',
      ...BACKGROUND,
      '--param',
      'ability_method=roll_assign',
      '--param',
      'features.fighting_style=dueling',
      '--param',
      'skills.trained=["athletics","perception"]',
    ];
    const abilities = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
    const take = (...rolls: number[]): string[] =>
      abilities.flatMap((ability, i) => ['--param', `abilities.${ability}.roll=${rolls[i]}`]);

    const query = cli('5e/main.yaml', ...rest) as {
      query: Array<{ path: string; label?: string; options?: unknown[] }>;
    };
    expect(query.query.map((param) => param.path)).toEqual(abilities.map((ability) => `abilities.${ability}.roll`));
    expect(query.query[0]).toMatchObject({ label: 'Strength', options: [1, 2, 3, 4, 5, 6] });

    const data = cli('5e/main.yaml', '--strip-metadata', ...take(6, 5, 4, 3, 2, 1), ...rest) as {
      data: Record<string, unknown> & {
        roll_assign: { rolls: number[] };
        abilities: Record<string, { roll: number; start: number; base: number }>;
      };
    };
    // The private `_taken` picks stay out of stripped output.
    expect(Object.keys(data.data.roll_assign)).toEqual(['rolls']);
    const { rolls } = data.data.roll_assign;
    expect(rolls).toHaveLength(6);
    for (const roll of rolls) {
      expect(roll).toBeGreaterThanOrEqual(3);
      expect(roll).toBeLessThanOrEqual(18);
    }
    // Each ability starts at the pooled roll it took — the same roll the pool shows.
    for (const [name, entry] of Object.entries(data.data.abilities)) {
      expect(entry.start).toBe(rolls[entry.roll - 1]);
      expect(entry.base).toBe(entry.start + BACKGROUND_BONUS(name));
    }
    expect(data.data.point_buy).toBeUndefined();
    expect(data.data.standard_array).toBeUndefined();

    // Every roll once: a repeat leaves another untaken.
    expect(cli('5e/main.yaml', ...take(6, 5, 4, 3, 2, 6), ...rest)).toEqual({
      errors: ['$lib.set.subset([1, 2, 3, 4, 5, 6], ._taken)'],
    });
    expect(cliFails('5e/main.yaml', ...take(7, 5, 4, 3, 2, 1), ...rest)).toContain(
      'param options mismatch: abilities.strength.roll expected one of [1, 2, 3, 4, 5, 6], got 7',
    );
  });

  describe('subclasses', () => {
    const base = [
      '--strip-metadata',
      '--param',
      'name=Aria',
      '--param',
      'class=fighter',
      '--param',
      'species=dwarf',
      ...BACKGROUND,
      '--param',
      'ability_method=roll',
      '--param',
      'features.fighting_style=dueling',
      '--param',
      'skills.trained=["athletics","perception"]',
    ];
    // Every fighter ability improvement, so high levels resolve.
    const improvements = [4, 6, 8, 12, 14, 16].flatMap((level) => [
      '--param',
      `improvements.level_${level}=["strength","strength"]`,
    ]);
    // biome-ignore lint/suspicious/noExplicitAny: assertions walk loose JSON sheets
    type Sheet = { data: Record<string, any>; errors?: string[] };
    const sheet = (xp: number, archetype: string, ...extra: string[]) =>
      cli(
        '5e/main.yaml',
        ...base,
        ...improvements,
        '--param',
        `xp=${xp}`,
        '--param',
        `features.martial_archetype=${archetype}`,
        ...extra,
      ) as Sheet;

    it('applies only the chosen subclass, from 3rd level', () => {
      const early = cli('5e/main.yaml', ...base, '--param', 'xp=899') as Sheet;
      expect(early.data.features.improved_critical).toBeUndefined();
      const champion = sheet(900, 'champion').data;
      expect(champion.critical_hit).toBe(19);
      expect(champion.features.spellcasting).toBeUndefined();
      expect(champion.resources.superiority_dice).toBeUndefined();
    });

    it('widens the champion critical range and adds its later features', () => {
      const champion = sheet(265000, 'champion', '--param', 'features.additional_fighting_style=defense').data;
      expect(champion.critical_hit).toBe(18);
      expect(champion.features.remarkable_athlete).toEqual({ bonus: 3 }); // half of +6, rounded up
      expect(champion.features.additional_fighting_style).toBe('defense');
      expect(Object.keys(champion.features.survivor)).toEqual(['regain']);
    });

    it('gives the battle master superiority dice and maneuvers, each learned once', () => {
      const learned = [
        '--param',
        'proficiencies.tools=smiths_tools',
        '--param',
        'maneuvers.level_3=["parry","riposte","trip_attack"]',
        '--param',
        'maneuvers.level_7=["rally","feinting_attack"]',
        '--param',
        'maneuvers.level_10=["menacing_attack","lunging_attack"]',
      ];
      const early = cli(
        '5e/main.yaml',
        ...base,
        '--param',
        'xp=900',
        '--param',
        'features.martial_archetype=battle_master',
      ) as {
        query: Array<{ path: string; count?: number }>;
      };
      expect(early.query.map((param) => [param.path, param.count])).toEqual([
        ['proficiencies.tools', undefined],
        ['maneuvers.level_3', 3],
      ]);
      const master = sheet(
        265000,
        'battle_master',
        ...learned,
        '--param',
        'maneuvers.level_15=["pushing_attack","sweeping_attack"]',
      ).data;
      expect(master.resources.superiority_dice).toEqual({ current: 6, max: 6, die: 'd12', recover: 'short' });
      expect(master.proficiencies.tools).toBe('smiths_tools');
      // A maneuver learned again at a later level breaks the sheet's rule.
      expect(
        sheet(265000, 'battle_master', ...learned, '--param', 'maneuvers.level_15=["pushing_attack","rally"]'),
      ).toEqual({
        errors: ['$lib.list.size(.*) == $lib.list.size($lib.set.union(.*, []))'],
      });
    });

    it('casts as an eldritch knight, with slots that grow by level', () => {
      const knight = sheet(305000, 'eldritch_knight').data;
      expect(knight.features.spellcasting).toMatchObject({
        ability: 'intelligence',
        cantrips_known: 3,
        spells_known: 12,
      });
      expect([1, 2, 3, 4].map((tier) => knight.resources[`spell_slots_${tier}`]?.max)).toEqual([4, 3, 3, 1]);
      const novice = sheet(900, 'eldritch_knight').data;
      expect(novice.resources.spell_slots_1).toEqual({ current: 2, max: 2, recover: 'long' });
      expect(novice.resources.spell_slots_2).toBeUndefined();
    });
  });

  it('names each choice from the definition it was called with', () => {
    const query = cli(
      '5e/main.yaml',
      '--param',
      'name=Aria',
      '--param',
      'xp=6500',
      '--param',
      'class=fighter',
      '--param',
      'species=dwarf',
      ...BACKGROUND,
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

  it.each(TEMPLATES)('answers every choice from the $label template', ({ params }) => {
    const args = Object.entries(params).flatMap(([path, value]) => [
      '--param',
      `${path}=${typeof value === 'string' ? value : JSON.stringify(value)}`,
    ]);
    const { data } = cli('5e/main.yaml', ...args) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ species: { ':value': params.species }, class: { ':value': params.class } });
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
      'param options mismatch: features.fighting_style expected one of ["archery", "blind_fighting", "defense", "dueling", "great_weapon_fighting", "interception", "protection", "thrown_weapon_fighting", "two_weapon_fighting", "unarmed_fighting"], got "kung_fu"',
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
    // `--set` beats the derivation it replaced (level 1 at 0 XP), and says so.
    expect(data.data.level).toEqual({
      ':value': 5,
      ':events': [
        { ':source': 'character.yaml', ':line': 14, ':column': 1, ':set': 1 },
        // An override has no document line to cite.
        { ':source': 'override', ':version': 1, ':set': 5 },
      ],
    });
  });
});
