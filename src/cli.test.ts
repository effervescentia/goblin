import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseArgs, parseParamValue, USAGE } from './cli';

describe('parseArgs', () => {
  it('defaults to no entry and pretty output', () => {
    expect(parseArgs([])).toEqual({ entry: undefined, compact: false, help: false, params: {}, overrides: {} });
  });

  it('accepts a positional entry file', () => {
    expect(parseArgs(['player.yaml'])).toEqual({
      entry: 'player.yaml',
      compact: false,
      help: false,
      params: {},
      overrides: {},
    });
  });

  it('accepts --compact', () => {
    expect(parseArgs(['--compact'])).toEqual({
      entry: undefined,
      compact: true,
      help: false,
      params: {},
      overrides: {},
    });
    expect(parseArgs(['main.yaml', '--compact'])).toEqual({
      entry: 'main.yaml',
      compact: true,
      help: false,
      params: {},
      overrides: {},
    });
  });

  it('accepts --help and -h', () => {
    expect(parseArgs(['--help'])).toEqual({ entry: undefined, compact: false, help: true, params: {}, overrides: {} });
    expect(parseArgs(['-h'])).toEqual({ entry: undefined, compact: false, help: true, params: {}, overrides: {} });
  });

  it('accepts repeatable --param key=value', () => {
    expect(parseArgs(['--param', 'hero_name=Aria'])).toEqual({
      entry: undefined,
      compact: false,
      help: false,
      params: { hero_name: 'Aria' },
      overrides: {},
    });
    expect(parseArgs(['--param', 'level=3', '--param', 'name=Aria'])).toEqual({
      entry: undefined,
      compact: false,
      help: false,
      params: { level: 3, name: 'Aria' },
      overrides: {},
    });
  });

  it('parses --param array values', () => {
    expect(parseArgs(['--param', 'skills.trained=["athletics","perception"]'])).toEqual({
      entry: undefined,
      compact: false,
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
      help: false,
      params: {},
      overrides: { level: 5 },
    });
    expect(parseArgs(['--param', 'name=Aria', '--set', 'level=5', '--set', 'a.b=1'])).toEqual({
      entry: undefined,
      compact: false,
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

  it('rejects unexpected arguments', () => {
    expect(() => parseArgs(['--bogus'])).toThrow('unexpected argument');
    expect(() => parseArgs(['a.yaml', 'b.yaml'])).toThrow('unexpected argument');
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
    expect(USAGE).toContain('goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--help]');
    expect(USAGE).toContain('--compact');
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
});
