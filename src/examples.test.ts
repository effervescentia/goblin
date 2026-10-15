import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Keeps examples/ honest: every example must resolve through the real CLI,
// and the applied-document pair must behave under engine.apply().
// Shelled out to `bun` so this works regardless of which runtime runs vitest.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(join(root, 'examples'))
  .filter((f) => f.endsWith('.yaml'))
  .sort();

function cli(entry: string, ...extra: string[]): unknown {
  const out = execFileSync('bun', ['src/cli.ts', entry, '--compact', ...extra], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

describe('examples', () => {
  it.each(files)('%s resolves to JSON', (file) => {
    const state = cli(`examples/${file}`);
    expect(typeof state).toBe('object');
    expect(state).not.toBeNull();
  });

  it('08-parameters.yaml returns a query until satisfied, then data', () => {
    const query = cli('examples/08-parameters.yaml') as {
      query: Array<{ path: string }>;
    };
    expect(query.query.map((param) => param.path).sort()).toEqual(['details.title', 'hero_name', 'starting_level']);

    const data = cli(
      'examples/08-parameters.yaml',
      '--param',
      'hero_name=Aria',
      '--param',
      'starting_level=3',
      '--param',
      'details.title=Kid',
    ) as { data: Record<string, unknown> };
    expect(data.data.hero_name).toEqual({
      ':doc': "The hero's name, as sung by bards.",
      ':param': true,
      ':type': 'string',
      ':value': 'Aria',
    });
    expect(data.data.level).toEqual({
      ':doc': 'Starting level, 1 through 20.',
      ':param': 'starting_level',
      ':type': 'integer',
      ':value': 3,
    });
  });

  it('04-functions.yaml hands back a record body per call', () => {
    const data = (cli('examples/04-functions.yaml') as { data: Record<string, unknown> }).data;
    expect(data.off_hand).toEqual({
      ':label': 'Heater Shield',
      ':doc': 'A sturdy board of wood and iron.',
      armor_class: 12, // base_armor 10 + the bonus it was called with
    });
    expect(data.shield).toMatchObject({ ':type': 'function', ':params': ['name', 'bonus'] });
  });

  it('10-choice-params.yaml reports constraints in query, enforces them in data', () => {
    const query = cli('examples/10-choice-params.yaml') as { query: Array<Record<string, unknown>> };
    expect(query.query).toEqual([
      {
        path: 'style',
        label: 'Fighting Style',
        doc: 'Pick a fighting style.',
        type: 'string',
        options: ['archery', 'dueling'],
      },
      {
        path: 'trained',
        doc: 'Pick two skills.',
        type: 'array',
        options: ['arcana', 'history', 'stealth'],
        count: 2,
        unique: true,
      },
      { path: 'score', doc: 'Point-buy score.', type: 'integer', min: 8, max: 15 },
    ]);

    const data = cli(
      'examples/10-choice-params.yaml',
      '--param',
      'style=dueling',
      '--param',
      'trained=["arcana","stealth"]',
      '--param',
      'score=15',
    ) as { data: Record<string, Record<string, unknown>> };
    expect(data.data.style).toEqual({
      ':label': 'Fighting Style',
      ':doc': 'Pick a fighting style.',
      ':param': true,
      ':type': 'string',
      ':options': ['archery', 'dueling'],
      ':value': 'dueling',
    });
    expect(data.data.trained?.[':value']).toEqual(['arcana', 'stealth']);
    expect(data.data.score?.[':value']).toBe(15);
  });

  it('09-stdlib.yaml resolves $lib with no attaching', () => {
    const state = cli('examples/09-stdlib.yaml', '--strip-metadata') as {
      data: Record<string, unknown>;
    };
    const { ability_roll, ...rest } = state.data;
    expect(ability_roll).toBeGreaterThanOrEqual(3);
    expect(ability_roll).toBeLessThanOrEqual(18);
    expect(rest).toEqual({
      floored: 2,
      smallest: 3,
      picks: { first: 'athletics', second: 'athletics' },
      athletics_picks: 2,
      picks_made: 2,
      trained_in_stealth: 0,
      melee: ['athletics', 'intimidation'],
      scouting: ['athletics', 'perception', 'survival'],
      either: ['athletics', 'intimidation', 'perception', 'survival'],
      both: ['athletics'],
      melee_only: ['intimidation'],
      melee_is_scouting: 0,
      picked_athletics: 1,
    });
  });

  it('05-templates.yaml reads # in a template function as the template', () => {
    const state = cli('examples/05-templates.yaml', '--strip-metadata') as { data: Record<string, unknown> };
    expect(state.data).toMatchObject({ weight: 100, heft: 8 });
  });

  it('14-mixin-actor.yaml merges its typed mixin and drops the call', () => {
    const state = cli('examples/14-mixin-actor.yaml', '--strip-metadata') as { data: unknown };
    expect(state.data).toEqual({ speed: 40, gold: 15 });
  });

  it('13-wildcards.yaml reads every match and refills by rule', () => {
    const state = cli('examples/13-wildcards.yaml', '--strip-metadata') as { data: Record<string, unknown> };
    expect(state.data).toMatchObject({ maxes: [2, 3], pools: 2, short_maxes: [2] });
    const script = `
      import { GoblinEngine } from './src/engine.ts';
      const e = new GoblinEngine('examples');
      await e.loadFile('13-wildcards.yaml');
      const doc = e.docs.get('13-wildcards.yaml');
      e.evaluateDoc('13-wildcards.yaml').rest.short();
      console.log(JSON.stringify([doc.resources.surge.current, doc.resources.indomitable.current]));
    `;
    const out = execFileSync('bun', ['-e', script], { cwd: root, encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual([2, 0]);
  });

  it('12-indexing.yaml picks list items by position', () => {
    const state = cli('examples/12-indexing.yaml') as { data: Record<string, unknown> };
    expect(state.data).toMatchObject({ first: 'gold', last: 'bronze', placed: 'silver', missing: null, corner: 3 });
  });

  it('11-private-fields.yaml reads its own `_` fields and strips them', () => {
    const state = cli('examples/11-private-fields.yaml', '--strip-metadata') as { data: unknown };
    expect(state.data).toEqual({ budget: { limit: 27, left: 15 } });
  });

  it('applies 07-class.yaml to 07-actor.yaml with $if gating', () => {
    const script = `
      import { GoblinEngine } from './src/engine.ts';
      import { debug } from './src/nodes/serialize.ts';
      const e = new GoblinEngine('examples');
      // Fields a patch wrote print as { :value, :events } — read the value.
      const val = (v) => (v && typeof v === 'object' && ':value' in v ? v[':value'] : v);
      await e.loadFile('07-actor.yaml');
      await e.loadFile('07-class.yaml');
      const run = (level) => {
        const actor = structuredClone(e.docs.get('07-actor.yaml'));
        actor.level = level;
        e.apply(actor, '07-class.yaml');
        const scope = { doc: actor, actor, app: e.appRoot, current: actor };
        return e.evaluate(actor, scope);
      };
      const l1 = run(1);
      const l2 = run(2);
      console.log(JSON.stringify({
        l1ac: val(l1.armor_class),
        l1die: String(val(l1.actions.unarmed_strike.die)),
        l1focus: 'monks_focus' in l1.features,
        l1martial: 'martial_arts' in l1.features,
        l2die: String(val(l2.actions.unarmed_strike.die)),
        l2type: val(l2.actions.unarmed_strike.type),
        l2focus: 'monks_focus' in l2.features,
        l2dieEvents: debug(l2.actions.unarmed_strike.die[':events']),
        martialEvents: l2.features.martial_arts[':events'],
        martialDieEvents: debug(l2.monk.martial_arts_die[':events']),
      }));
    `;
    const out = execFileSync('bun', ['-e', script], { cwd: root, encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual({
      l1ac: 12,
      l1die: 'd4',
      l1focus: false,
      l1martial: true,
      l2die: '1d8',
      l2type: 'bonus_action',
      l2focus: true,
      // The actor's own `d4`, then the `$then` write that replaced it.
      l2dieEvents: [{ ':set': 'd4' }, { ':source': '07-class.yaml', ':line': 32, ':column': 5, ':set': '1d8' }],
      // A field the patch created has no origin event.
      martialDieEvents: [{ ':source': '07-class.yaml', ':line': 13, ':column': 1, ':set': '1d6' }],
      // A `+key` feature (metadata only) still records the addition.
      martialEvents: [{ ':source': '07-class.yaml', ':line': 15, ':column': 3, ':add': 'martial_arts' }],
    });
  });
});
