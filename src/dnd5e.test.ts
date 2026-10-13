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

const script = `
  import { GoblinEngine } from './src/engine.ts';
  import { collectParams } from './src/utils.ts';
  const e = new GoblinEngine('5e');
  // Single load: engine discovery follows $tmpl refs (main → character,
  // fighter, levels) automatically.
  await e.loadFile('main.yaml');

  const baseMissing = e.missingParams('character.yaml').map((m) => m.path).sort();

  const fresh = () => structuredClone(e.docs.get('character.yaml'));
  const scopeOf = (actor, provided) => ({ doc: actor, actor, app: e.appRoot, current: actor, provided });
  const baseProvided = (xp) => ({
    name: 'X',
    xp,
    'features.fighting_style': 'defense',
    'features.martial_archetype': 'Champion',
    'skills.trained': ['athletics', 'perception'],
  });

  // Derive the level from XP, then adopt the fighter: omitted maxLevel
  // applies exactly the earned levels automatically.
  const run = (xp) => {
    const a = fresh();
    const provided = baseProvided(xp);
    const lv = e.evaluate(a, scopeOf(a, provided)).level;
    e.apply(a, 'fighter.yaml');
    return { lv, v: e.evaluate(a, scopeOf(a, provided)) };
  };

  const a3 = fresh();
  e.evaluate(a3, scopeOf(a3, { name: 'X', xp: 900 }));
  e.apply(a3, 'fighter.yaml');
  const mergedMissing = collectParams(a3).map((m) => m.path).sort();

  const levels = {};
  for (const xp of [0, 299, 300, 899, 900, 2699, 2700, 6499, 6500, 354999, 355000, 999999]) {
    levels[xp] = run(xp).lv;
  }
  levels.none = (() => {
    const a = fresh();
    return e.evaluate(a, scopeOf(a, { name: 'X' })).level;
  })();

  const r = (xp) => run(xp).v;
  const attacks = { 0: r(0).attacks, 6500: r(6500).attacks, 85000: r(85000).attacks, 355000: r(355000).attacks };
  const prof = { 0: r(0).proficiency_bonus, 6500: r(6500).proficiency_bonus, 48000: r(48000).proficiency_bonus, 225000: r(225000).proficiency_bonus };
  const v5 = r(6500);
  const sw = v5.actions.second_wind.heal();

  // Resolve envelope for a satisfied fighter.
  const a5 = fresh();
  const provided5 = { ...baseProvided(6500), name: 'Bram' };
  e.evaluate(a5, scopeOf(a5, provided5));
  e.apply(a5, 'fighter.yaml');
  e.docs.set('fighter5.yaml', a5);
  const resolved = e.resolve('fighter5.yaml', provided5);

  console.log(JSON.stringify({
    baseMissing,
    mergedMissing,
    ac: v5.armor_class,
    hp: { value: v5.hit_points.value, max: v5.hit_points.max },
    trained: v5.skills.trained.value,
    surge: { value: v5.resources.action_surge.value, max: v5.resources.action_surge.max },
    swMin: sw >= 6,
    swMax: sw <= 15,
    levels,
    attacks,
    prof,
    resolvedKeys: Object.keys(resolved),
    resolvedAttacks: resolved.data.attacks,
    resolvedLevel: resolved.data.level,
  }));
`;

describe('5e', () => {
  it('levels a fighter from 1 to 20 on XP', () => {
    const out = execFileSync('bun', ['-e', script], { cwd: root, encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual({
      baseMissing: ['name'],
      mergedMissing: ['features.fighting_style', 'features.martial_archetype', 'name', 'skills.trained'],
      ac: 10,
      hp: { value: 10, max: 10 },
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
    const query = cli('5e/main.yaml') as { query: Array<{ path: string }> };
    expect(query.query.map((param) => param.path).sort()).toEqual([
      'features.fighting_style',
      'name',
      'skills.trained',
    ]);

    const data = cli(
      '5e/main.yaml',
      '--param',
      'name=Aria',
      '--param',
      'xp=6500',
      '--param',
      'features.fighting_style=dueling',
      '--param',
      'features.martial_archetype=Champion',
      '--param',
      'skills.trained=["athletics","perception"]',
    ) as {
      data: {
        level: number;
        attacks: number;
        armor_class: number;
        features: Record<string, { value: unknown }>;
      };
    };
    expect(data.data.level).toBe(5);
    expect(data.data.attacks).toBe(2);
    expect(data.data.armor_class).toBe(10);
    expect(data.data.features.fighting_style?.value).toBe('dueling');
  });

  it('overrides level explicitly without XP', () => {
    const query = cli('5e/main.yaml', '--set', 'level=5', '--param', 'name=Aria') as {
      query: Array<{ path: string }>;
    };
    // Adoption follows the overridden level (L5 features apply); xp has a
    // default so it is not asked.
    expect(query.query.map((param) => param.path).sort()).toEqual([
      'features.fighting_style',
      'features.martial_archetype',
      'skills.trained',
    ]);

    const data = cli(
      '5e/main.yaml',
      '--set',
      'level=5',
      '--param',
      'name=Aria',
      '--param',
      'xp=0',
      '--param',
      'features.fighting_style=dueling',
      '--param',
      'features.martial_archetype=Champion',
      '--param',
      'skills.trained=[]',
    ) as { data: { level: number; attacks: number } };
    expect(data.data.level).toBe(5);
    expect(data.data.attacks).toBe(2);
  });
});
