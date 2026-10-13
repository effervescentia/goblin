import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli';

describe('parseArgs', () => {
  it('defaults to no entry and pretty output', () => {
    expect(parseArgs([])).toEqual({ entry: undefined, compact: false });
  });

  it('accepts a positional entry file', () => {
    expect(parseArgs(['player.yaml'])).toEqual({ entry: 'player.yaml', compact: false });
  });

  it('accepts --compact', () => {
    expect(parseArgs(['--compact'])).toEqual({ entry: undefined, compact: true });
    expect(parseArgs(['main.yaml', '--compact'])).toEqual({ entry: 'main.yaml', compact: true });
  });

  it('rejects unexpected arguments', () => {
    expect(() => parseArgs(['--bogus'])).toThrow('unexpected argument');
    expect(() => parseArgs(['a.yaml', 'b.yaml'])).toThrow('unexpected argument');
  });
});
