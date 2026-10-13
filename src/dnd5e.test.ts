import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// End-to-end over the real 5e/ documents (parsed by Bun, so shelled out like
// src/examples.test.ts): leveling, class adoption, choices, and progression.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const script = `
  import { GoblinEngine } from './src/engine.ts';
  import { collectParams } from './src/utils.ts';
  const e = new GoblinEngine('5e');
  await e.loadFile('character.yaml');
  await e.loadFile('fighter.yaml');

  const baseMissing = e.missingParams('character.yaml').map((m) => m.path).sort();

  const fresh = () => structuredClone(e.docs.get('character.yaml'));
  const scopeOf = (actor, provided) => ({ doc: actor, actor, app: e.appRoot, current: actor, provided });

  // Fighter 3 with all choices provided.
  const a3 = fresh();
  e.apply(a3, 'fighter.yaml', 3);
  const mergedMissing = collectParams(a3).map((m) => m.path).sort();
  const provided3 = { name: 'Aria', level: 3, 'features.fighting_style': 'defense', 'features.martial_archetype': 'Champion', 'skills.trained': ['athletics', 'perception'] };
  const v3 = e.evaluate(a3, scopeOf(a3, provided3));
  const sw = v3.actions.second_wind.heal();

  // Attacks and proficiency across levels.
  const attacks = {};
  const prof = {};
  for (const lv of [1, 3, 5, 11, 20]) {
    const a = fresh();
    e.apply(a, 'fighter.yaml', lv);
    const v = e.evaluate(a, scopeOf(a, { name: 'X', level: lv, 'features.fighting_style': 'defense', 'features.martial_archetype': 'Champion', 'skills.trained': [] }));
    attacks[lv] = v.attacks;
    if (lv === 1 || lv === 5 || lv === 9 || lv === 17) prof[lv] = v.proficiency_bonus;
  }
  const a9 = fresh();
  e.apply(a9, 'fighter.yaml', 9);
  prof[9] = e.evaluate(a9, scopeOf(a9, { name: 'X', level: 9, 'features.fighting_style': 'defense', 'features.martial_archetype': 'Champion', 'skills.trained': [] })).proficiency_bonus;
  const a17 = fresh();
  e.apply(a17, 'fighter.yaml', 17);
  prof[17] = e.evaluate(a17, scopeOf(a17, { name: 'X', level: 17, 'features.fighting_style': 'defense', 'features.martial_archetype': 'Champion', 'skills.trained': [] })).proficiency_bonus;

  // Resolve envelope for a satisfied fighter.
  const a5 = fresh();
  e.apply(a5, 'fighter.yaml', 5);
  e.docs.set('fighter5.yaml', a5);
  const resolved = e.resolve('fighter5.yaml', { name: 'Bram', level: 5, 'features.fighting_style': 'dueling', 'features.martial_archetype': 'Champion', 'skills.trained': [] });

  console.log(JSON.stringify({
    baseMissing,
    mergedMissing,
    ac: v3.armor_class,
    prof3: v3.proficiency_bonus,
    hp: { value: v3.hit_points.value, max: v3.hit_points.max },
    surge: v3.resources.action_surge,
    swMin: sw >= 4,
    swMax: sw <= 13,
    attacks,
    prof,
    resolvedKeys: Object.keys(resolved),
    resolvedAttacks: resolved.data.attacks,
  }));
`;

describe('5e', () => {
  it('levels a fighter from 1 to 20', () => {
    const out = execFileSync('bun', ['-e', script], { cwd: root, encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual({
      baseMissing: ['level', 'name'],
      mergedMissing: ['features.fighting_style', 'features.martial_archetype', 'level', 'name', 'skills.trained'],
      ac: 10,
      prof3: 2,
      hp: { value: 10, max: 10 },
      surge: { value: 1, max: 1, ':doc': 'Take one additional action on your turn. Restores on a short rest.' },
      swMin: true,
      swMax: true,
      attacks: { 1: 1, 3: 1, 5: 2, 11: 3, 20: 4 },
      prof: { 1: 2, 5: 3, 9: 4, 17: 6 },
      resolvedKeys: ['data'],
      resolvedAttacks: 2,
    });
  });
});
