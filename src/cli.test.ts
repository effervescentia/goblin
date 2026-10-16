import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseArgs, parseParamValue, USAGE } from './cli';
import { COMPANION_PARAMS } from './dnd5e.fixtures';
import { print } from './nodes/serialize';

describe('parseArgs', () => {
  it('defaults to no entry and pretty output', () => {
    expect(parseArgs([])).toEqual({
      entry: undefined,
      compact: false,
      stripMetadata: false,
      help: false,
      params: {},
      overrides: {},
    });
  });

  it('accepts a positional entry file', () => {
    expect(parseArgs(['player.yaml'])).toEqual({
      entry: 'player.yaml',
      compact: false,
      stripMetadata: false,
      help: false,
      params: {},
      overrides: {},
    });
  });

  it('accepts --compact', () => {
    expect(parseArgs(['--compact'])).toEqual({
      entry: undefined,
      compact: true,
      stripMetadata: false,
      help: false,
      params: {},
      overrides: {},
    });
    expect(parseArgs(['main.yaml', '--compact'])).toEqual({
      entry: 'main.yaml',
      compact: true,
      stripMetadata: false,
      help: false,
      params: {},
      overrides: {},
    });
  });

  it('accepts --strip-metadata', () => {
    expect(parseArgs(['--strip-metadata'])).toEqual({
      entry: undefined,
      compact: false,
      stripMetadata: true,
      help: false,
      params: {},
      overrides: {},
    });
    expect(parseArgs(['main.yaml', '--compact', '--strip-metadata'])).toEqual({
      entry: 'main.yaml',
      compact: true,
      stripMetadata: true,
      help: false,
      params: {},
      overrides: {},
    });
  });

  it('accepts --help and -h', () => {
    expect(parseArgs(['--help'])).toEqual({
      entry: undefined,
      compact: false,
      stripMetadata: false,
      help: true,
      params: {},
      overrides: {},
    });
    expect(parseArgs(['-h'])).toEqual({
      entry: undefined,
      compact: false,
      stripMetadata: false,
      help: true,
      params: {},
      overrides: {},
    });
  });

  it('accepts repeatable --param key=value', () => {
    expect(parseArgs(['--param', 'hero_name=Aria'])).toEqual({
      entry: undefined,
      compact: false,
      stripMetadata: false,
      help: false,
      params: { hero_name: 'Aria' },
      overrides: {},
    });
    expect(parseArgs(['--param', 'level=3', '--param', 'name=Aria'])).toEqual({
      entry: undefined,
      compact: false,
      stripMetadata: false,
      help: false,
      params: { level: 3, name: 'Aria' },
      overrides: {},
    });
  });

  it('parses --param array values', () => {
    expect(parseArgs(['--param', 'skills.trained=["athletics","perception"]'])).toEqual({
      entry: undefined,
      compact: false,
      stripMetadata: false,
      help: false,
      params: { 'skills.trained': ['athletics', 'perception'] },
      overrides: {},
    });
  });

  it('splits --param on the first =', () => {
    expect(parseArgs(['--param', 'a=b=c']).params).toEqual({ a: 'b=c' });
  });

  it('rejects malformed --param', () => {
    expect(() => parseArgs(['--param'])).toThrow('--param expects key=value');
    expect(() => parseArgs(['--param', 'nokey'])).toThrow('--param expects key=value');
    expect(() => parseArgs(['--param', '=novalue'])).toThrow('--param expects key=value');
  });

  it('accepts repeatable --set path=value apart from --param', () => {
    expect(parseArgs(['--set', 'level=5'])).toEqual({
      entry: undefined,
      compact: false,
      stripMetadata: false,
      help: false,
      params: {},
      overrides: { level: 5 },
    });
    expect(parseArgs(['--param', 'name=Aria', '--set', 'level=5', '--set', 'a.b=1'])).toEqual({
      entry: undefined,
      compact: false,
      stripMetadata: false,
      help: false,
      params: { name: 'Aria' },
      overrides: { level: 5, 'a.b': 1 },
    });
  });

  it('rejects malformed --set', () => {
    expect(() => parseArgs(['--set'])).toThrow('--set expects key=value');
    expect(() => parseArgs(['--set', 'nokey'])).toThrow('--set expects key=value');
    expect(() => parseArgs(['--set', '=novalue'])).toThrow('--set expects key=value');
  });

  it('accepts --out with a path', () => {
    expect(parseArgs(['main.yaml', '--out', 'out/sheet.json']).out).toBe('out/sheet.json');
    expect(() => parseArgs(['--out'])).toThrow('--out expects a file path');
    expect(() => parseArgs(['--out', '--compact'])).toThrow('--out expects a file path');
  });

  it('rejects unexpected arguments', () => {
    expect(() => parseArgs(['--bogus'])).toThrow('unexpected argument');
    expect(() => parseArgs(['a.yaml', 'b.yaml'])).toThrow('unexpected argument');
  });
});

describe('print', () => {
  it('drops :-prefixed and !validate keys recursively, keeping values', () => {
    expect(
      print({
        name: 'Aria',
        hit_points: { '!validate': ['.current >= 0'], current: 10, max: 10 },
        features: { second_wind: { ':doc': 'Regain.' } },
        utils: {
          ability_modifier: { ':type': 'function', ':params': ['x'], ':source': 'x * 2', ':deps': [] },
          partial: { ':type': 'function' },
        },
        tags: [{ ':doc': 't', label: 'a' }, 'b'],
        level: 5,
        xp: { ':doc': 'XP.', ':param': true, ':type': 'integer', ':default': 0, ':value': 6500 },
        nick: { ':param': true, ':value': null },
        attacks: { ':value': 2, ':events': [{ ':source': 'fighter.yaml', ':set': '1 + (@.level >= 5)' }] },
        armor: { ':value': ['shields'], ':events': [{ ':add': ['shields'] }] },
      }),
    ).toEqual({
      name: 'Aria',
      hit_points: { current: 10, max: 10 },
      features: { second_wind: null },
      utils: { ability_modifier: 'x * 2', partial: null },
      tags: [{ label: 'a' }, 'b'],
      level: 5,
      xp: 6500,
      nick: null,
      attacks: 2,
      armor: ['shields'],
    });
    expect(print('d10')).toBe('d10');
    expect(print(null)).toBeNull();
  });
});

describe('parseParamValue', () => {
  it('parses JSON, falling back to strings', () => {
    expect(parseParamValue('3')).toBe(3);
    expect(parseParamValue('true')).toBe(true);
    expect(parseParamValue('["a"]')).toEqual(['a']);
    expect(parseParamValue('Aria')).toBe('Aria');
    expect(parseParamValue('1d8')).toBe('1d8');
  });
});

describe('USAGE', () => {
  it('documents the CLI', () => {
    expect(USAGE).toContain(
      'goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--strip-metadata] [--out file.json] [--help]',
    );
    expect(USAGE).toContain('--out');
    expect(USAGE).toContain('--compact');
    expect(USAGE).toContain('--strip-metadata');
    expect(USAGE).toContain('--param');
    expect(USAGE).toContain('--set');
    expect(USAGE).toContain('--help, -h');
  });
});

// Subprocess tests through the real entry point (Bun-only code paths).
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function runCli(...args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('bun', ['src/cli.ts', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const failed = err as { stdout?: unknown; stderr?: unknown; status?: unknown };
    return {
      stdout: String(failed.stdout ?? ''),
      stderr: String(failed.stderr ?? ''),
      status: typeof failed.status === 'number' ? failed.status : 1,
    };
  }
}

describe('cli', () => {
  it('uses .goblin.yaml from cwd when no entry is supplied', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goblin-cli-'));
    mkdirSync(join(cwd, 'docs', 'nested'), { recursive: true });
    writeFileSync(join(cwd, '.goblin.yaml'), 'root: docs\nmain: nested/actor.yaml\n');
    writeFileSync(join(cwd, 'docs', 'nested', 'actor.yaml'), 'name: Config actor\n');
    try {
      const stdout = execFileSync('bun', [join(root, 'src/cli.ts')], { cwd, encoding: 'utf8' });
      expect(JSON.parse(stdout)).toEqual({ data: { name: 'Config actor' } });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('errors when no entry or .goblin.yaml is available', () => {
    const res = runCli();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('no entry provided and .goblin.yaml was not found');
  });

  it('--help prints usage and exits 0', () => {
    const res = runCli('--help');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('goblin [entry.yaml]');
  });

  it('rejects unknown flags with exit 1', () => {
    const res = runCli('--bogus');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unexpected argument: --bogus');
  });

  it('errors on missing entry files', () => {
    const res = runCli('nope.yaml');
    expect(res.status).toBe(1);
    expect(res.stderr.length).toBeGreaterThan(0);
  });

  it('--compact emits single-line JSON, default pretty-prints', () => {
    const compact = runCli('examples/02-expressions.yaml', '--compact');
    expect(compact.status).toBe(0);
    expect(JSON.parse(compact.stdout)).toMatchObject({ data: { sum: 29 } });
    expect(compact.stdout.trimEnd().includes('\n')).toBe(false);

    const pretty = runCli('examples/02-expressions.yaml');
    expect(pretty.status).toBe(0);
    expect(pretty.stdout.trimEnd().includes('\n')).toBe(true);
    expect(JSON.parse(pretty.stdout)).toEqual(JSON.parse(compact.stdout));
  });

  it('--out replaces the file with the output only when the document fully resolves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goblin-out-'));
    const out = join(dir, 'nested', 'sheet.json');
    try {
      mkdirSync(join(dir, 'nested'));
      writeFileSync(out, 'stale');
      const res = runCli('examples/02-expressions.yaml', '--compact', '--out', out);
      expect(res.status).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe(res.stdout);

      const pending = join(dir, 'pending.json');
      const query = runCli('examples/08-parameters.yaml', '--out', pending);
      expect(query.status).toBe(0);
      expect(JSON.parse(query.stdout)).toHaveProperty('query');
      expect(existsSync(pending)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--strip-metadata drops metadata keys from data output', () => {
    // 5e/main.yaml nests its characters under `party`; this reads `aria`.
    const character = (data: Record<string, unknown>) =>
      (data.party as Record<string, Record<string, unknown>>).aria as Record<string, unknown>;
    const params = [
      '--param',
      'class=fighter',
      '--param',
      'species=dwarf',
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
    ].map((arg) => (arg === '--param' ? arg : `aria.${arg}`));
    const args = ['5e/main.yaml', '--compact', ...params, ...COMPANION_PARAMS];
    const full = runCli(...args);
    expect(full.status).toBe(0);
    const fullData = character((JSON.parse(full.stdout) as { data: Record<string, unknown> }).data);
    expect(JSON.stringify(fullData)).toContain(':doc');
    expect(fullData.name).toEqual({
      ':doc': "Your hero's name, as sung by bards.",
      ':param': true,
      ':type': 'string',
      ':value': 'Aria',
    });
    expect(fullData.xp).toEqual({
      ':doc': 'Experience points earned in play.',
      ':param': true,
      ':type': 'integer',
      ':default': 0,
      ':value': 6500,
    });

    const stripped = runCli(...args, '--strip-metadata');
    expect(stripped.status).toBe(0);
    const data = (JSON.parse(stripped.stdout) as { data: Record<string, unknown> }).data;
    const metaKeys: string[] = [];
    const visit = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k.startsWith(':') || k === '!validate') metaKeys.push(k);
          visit(v);
        }
      }
    };
    visit(data);
    expect(metaKeys).toEqual([]);
    const pc = character(data);
    expect(pc.hit_points).toEqual({ current: 11, max: 11 }); // con 13 → +1
    expect(pc.name).toBe('Aria');
    expect(pc.level).toBe(5);
    expect(pc.initiative).toEqual({ base: 2, roll: '1d20 + .base' }); // dex 14 → +2
    expect((pc.features as Record<string, unknown>).second_wind).toBeNull();
  });
});
