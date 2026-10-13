import { describe, expect, it } from 'vitest';
import { parseArgs, parseParamValue, USAGE } from './cli';

describe('parseArgs', () => {
  it('defaults to no entry and pretty output', () => {
    expect(parseArgs([])).toEqual({ entry: undefined, compact: false, help: false, params: {} });
  });

  it('accepts a positional entry file', () => {
    expect(parseArgs(['player.yaml'])).toEqual({ entry: 'player.yaml', compact: false, help: false, params: {} });
  });

  it('accepts --compact', () => {
    expect(parseArgs(['--compact'])).toEqual({ entry: undefined, compact: true, help: false, params: {} });
    expect(parseArgs(['main.yaml', '--compact'])).toEqual({
      entry: 'main.yaml',
      compact: true,
      help: false,
      params: {},
    });
  });

  it('accepts --help and -h', () => {
    expect(parseArgs(['--help'])).toEqual({ entry: undefined, compact: false, help: true, params: {} });
    expect(parseArgs(['-h'])).toEqual({ entry: undefined, compact: false, help: true, params: {} });
  });

  it('accepts repeatable --param key=value', () => {
    expect(parseArgs(['--param', 'hero_name=Aria'])).toEqual({
      entry: undefined,
      compact: false,
      help: false,
      params: { hero_name: 'Aria' },
    });
    expect(parseArgs(['--param', 'level=3', '--param', 'name=Aria'])).toEqual({
      entry: undefined,
      compact: false,
      help: false,
      params: { level: 3, name: 'Aria' },
    });
  });

  it('rejects malformed --param', () => {
    expect(() => parseArgs(['--param'])).toThrow('--param expects key=value');
    expect(() => parseArgs(['--param', 'nokey'])).toThrow('--param expects key=value');
    expect(() => parseArgs(['--param', '=novalue'])).toThrow('--param expects key=value');
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
    expect(USAGE).toContain('goblin [entry.yaml] [--compact] [--param key=value] [--help]');
    expect(USAGE).toContain('--compact');
    expect(USAGE).toContain('--param');
    expect(USAGE).toContain('--help, -h');
  });
});
