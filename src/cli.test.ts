import { describe, expect, it } from 'vitest';
import { parseArgs, USAGE } from './cli';

describe('parseArgs', () => {
  it('defaults to no entry and pretty output', () => {
    expect(parseArgs([])).toEqual({ entry: undefined, compact: false, help: false });
  });

  it('accepts a positional entry file', () => {
    expect(parseArgs(['player.yaml'])).toEqual({ entry: 'player.yaml', compact: false, help: false });
  });

  it('accepts --compact', () => {
    expect(parseArgs(['--compact'])).toEqual({ entry: undefined, compact: true, help: false });
    expect(parseArgs(['main.yaml', '--compact'])).toEqual({ entry: 'main.yaml', compact: true, help: false });
  });

  it('accepts --help and -h', () => {
    expect(parseArgs(['--help'])).toEqual({ entry: undefined, compact: false, help: true });
    expect(parseArgs(['-h'])).toEqual({ entry: undefined, compact: false, help: true });
  });

  it('rejects unexpected arguments', () => {
    expect(() => parseArgs(['--bogus'])).toThrow('unexpected argument');
    expect(() => parseArgs(['a.yaml', 'b.yaml'])).toThrow('unexpected argument');
  });
});

describe('USAGE', () => {
  it('documents the CLI', () => {
    expect(USAGE).toContain('goblin [entry.yaml] [--compact] [--help]');
    expect(USAGE).toContain('--compact');
    expect(USAGE).toContain('--help, -h');
  });
});
