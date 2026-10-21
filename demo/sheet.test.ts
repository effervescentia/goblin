import { describe, expect, it } from 'vitest';
import {
  at,
  combatOf,
  docOf,
  fields,
  formulaAt,
  humanize,
  labelOf,
  parseParam,
  picksAny,
  plainStep,
  readParam,
  signed,
  slotsOf,
  templateInputs,
  unwrap,
} from './sheet';

describe('sheet', () => {
  const sheet = {
    name: { ':param': true, ':value': 'Aria' },
    speed: { ':value': 30, ':events': [] },
    armor_class: {
      ':value': 12,
      ':formula': '10 + Dexterity',
      ':parts': [{ ':label': 'Dexterity', ':value': 2 }],
    },
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

  it('reads a labelled field’s formula and parts', () => {
    expect(formulaAt(sheet, 'armor_class')).toEqual({ formula: '10 + Dexterity', parts: ['Dexterity +2'] });
    expect(formulaAt(sheet, 'speed')).toBeUndefined();
    expect(formulaAt(sheet, 'hit_points.current')).toBeUndefined();
  });

  it('reads one level of a record as plain values, functions as their signature', () => {
    expect(plainStep(sheet.name)).toBe('Aria');
    expect(plainStep(sheet.armor_class)).toBe(12);
    expect(plainStep(sheet.hit_points)).toEqual({ current: sheet.hit_points.current, max: 11 });
    expect(plainStep({ ':type': 'function', ':params': [], ':source': '…' })).toBe('ƒ()');
    expect(plainStep({ ':type': 'function', ':params': ['target', 'amount'] })).toBe('ƒ(target, amount)');
    expect(plainStep({ ':value': { ':value': [1] } })).toEqual([1]);
  });

  it('reads a field’s `:doc`', () => {
    expect(docOf(sheet.features)).toBe('all of them');
    expect(docOf(sheet.speed)).toBeUndefined();
    expect(docOf('a string')).toBeUndefined();
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

  it('reads option picks by index, waiting on every slot', () => {
    const species = { path: 'aria.species', type: 'string', options: ['dwarf', 'elf'] };
    expect(slotsOf(species)).toBe(1);
    expect(readParam(species, [''])).toBeUndefined();
    expect(readParam(species, ['1'])).toBe('elf');

    const scores = { path: 'aria.abilities.strength.assigned', type: 'integer', options: [15, 14] };
    expect(readParam(scores, ['0'])).toBe(15);

    const improvements = { path: 'aria.improvements.level_4', type: 'array', options: ['str', 'dex'], count: 2 };
    expect(slotsOf(improvements)).toBe(2);
    expect(readParam(improvements, ['0'])).toBeUndefined();
    expect(readParam(improvements, ['0', '0'])).toEqual(['str', 'str']);

    expect(readParam({ path: 'aria.name', type: 'string' }, ['Aria'])).toBe('Aria');
  });

  it('sends a template as params under the character', () => {
    expect(templateInputs({ label: 'Test', params: { class: 'fighter', 'skills.trained': ['athletics'] } })).toEqual([
      { type: 'parameter', path: 'aria.class', value: 'fighter' },
      { type: 'parameter', path: 'aria.skills.trained', value: ['athletics'] },
    ]);
  });

  it('reads a choice of any distinct options as checked boxes', () => {
    const members = { path: 'combat.members', type: 'array', options: ['aria', 'bram'], unique: true };
    expect(picksAny(members)).toBe(true);
    expect(picksAny({ ...members, count: 2 })).toBe(false);
    expect(readParam(members, [])).toBeUndefined();
    expect(readParam(members, ['', '1'])).toEqual(['bram']);
    expect(readParam(members, ['1', '1'])).toEqual(['aria', 'bram']);
  });

  it('reads the fight in turn order, or null between fights', () => {
    expect(combatOf({ combat: { ':value': null, ':events': [] } })).toBeNull();
    const data = {
      combat: {
        initiative: { aria: 14, bram: 17 },
        order: ['bram', 'aria'],
        current: 'aria',
        round: { ':value': 2, ':events': [] },
      },
    };
    expect(combatOf(data)).toEqual({
      round: 2,
      current: 'aria',
      order: [
        { key: 'bram', initiative: 17 },
        { key: 'aria', initiative: 14 },
      ],
    });
  });
});
