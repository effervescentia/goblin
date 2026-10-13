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
    ) as { data: Record<string, { value: unknown }> };
    expect(data.data.hero_name?.value).toBe('Aria');
    expect(data.data.level?.value).toBe(3);
  });

  it('09-stdlib.yaml resolves $lib with no attaching', () => {
    const state = cli('examples/09-stdlib.yaml') as {
      data: { floored: number; smallest: number };
    };
    expect(state.data).toEqual({ floored: 2, smallest: 3 });
  });

  it('applies 07-class.yaml to 07-actor.yaml with $if gating', () => {
    const script = `
      import { GoblinEngine } from './src/engine.ts';
      const e = new GoblinEngine('examples');
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
        l1ac: l1.armor_class,
        l1die: String(l1.actions.unarmed_strike.die),
        l1focus: 'monks_focus' in l1.features,
        l1martial: 'martial_arts' in l1.features,
        l2die: String(l2.actions.unarmed_strike.die),
        l2type: l2.actions.unarmed_strike.type,
        l2focus: 'monks_focus' in l2.features,
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
    });
  });
});
