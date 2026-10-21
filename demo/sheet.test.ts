import { describe, expect, it } from 'vitest';
import { at, fields, humanize, labelOf, parseParam, signed, unwrap } from './sheet';

describe('sheet', () => {
  const sheet = {
    name: { ':param': true, ':value': 'Aria' },
    speed: { ':value': 30, ':events': [] },
    hit_points: { '!validate': ['.current >= 0'], current: { ':value': 11, ':events': [] }, max: 11 },
    features: { ':doc': 'all of them', _hidden: 1, darkvision: { ':label': 'Darkvision' }, extra_attack: {} },
  };

  it('unwraps evented and param fields', () => {
    expect(unwrap(sheet.name)).toBe('Aria');
    expect(unwrap(sheet.features)).toBe(sheet.features);
    expect(at(sheet, 'speed')).toBe(30);
    expect(at(sheet, 'hit_points.current')).toBe(11);
    expect(at(sheet, 'hit_points.missing.deeper')).toBeUndefined();
  });

  it('lists only a record’s own fields', () => {
    expect(fields(sheet.features).map(([key]) => key)).toEqual(['darkvision', 'extra_attack']);
    expect(fields(sheet.hit_points).map(([key]) => key)).toEqual(['current', 'max']);
    expect(fields('not a record')).toEqual([]);
  });

  it('labels fields by `:label`, else by their key', () => {
    expect(labelOf(sheet.features.darkvision, 'darkvision')).toBe('Darkvision');
    expect(labelOf(sheet.features.extra_attack, 'extra_attack')).toBe('Extra attack');
    expect(humanize('all_armor')).toBe('All armor');
  });

  it('signs modifiers', () => {
    expect(signed(3)).toBe('+3');
    expect(signed(0)).toBe('+0');
    expect(signed(-1)).toBe('-1');
  });

  it('parses free-form param input by type', () => {
    expect(parseParam({ path: 'aria.name', type: 'string' }, '')).toBeUndefined();
    expect(parseParam({ path: 'aria.name', type: 'string' }, 'Aria')).toBe('Aria');
    expect(parseParam({ path: 'aria.xp', type: 'integer' }, '6500')).toBe(6500);
    expect(parseParam({ path: 'aria.ready', type: 'boolean' }, 'true')).toBe(true);
    expect(parseParam({ path: 'aria.skills', type: 'array' }, '["athletics"]')).toEqual(['athletics']);
  });
});
