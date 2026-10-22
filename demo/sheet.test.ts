import { describe, expect, it } from 'vitest';
import type { InspectNode } from '@/inspect';
import {
  at,
  combatOf,
  describeEvent,
  docOf,
  eventsAt,
  expressionsOf,
  fields,
  formulaAt,
  humanize,
  labelOf,
  parseParam,
  picksAny,
  plainStep,
  readParam,
  type Segment,
  signed,
  slotsOf,
  solve,
  solvedText,
  solveRefs,
  sourceOf,
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
    abilities: {
      wisdom: {
        start: { ':value': 13, ':events': [] },
        base: {
          ':value': 15,
          ':formula': '.start + Improvements',
          ':parts': [{ ':label': 'Improvements', ':value': 2 }],
        },
      },
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
    expect(formulaAt(sheet, 'armor_class')).toEqual({
      formula: '10 + Dexterity',
      segments: [{ text: '10 + ' }, { label: 'Dexterity', value: 2, hue: 0 }],
    });
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

  it('reads the unlabelled refs in a formula: beside the field, or on the character', () => {
    const segments = formulaAt(sheet, 'abilities.wisdom.base')?.segments ?? [];
    expect(segments).toEqual([
      { ref: '.start', value: 13 },
      { text: ' + ' },
      { label: 'Improvements', value: 2, hue: 0 },
    ]);
    expect(solvedText(segments)).toBe('13 + 2');
    const read = (ref: string) => ({ '.a': 1, '@.b.c': 2 })[ref];
    expect(solvedText(solveRefs([{ text: '.a + @.b.c + #.a + $lib.a + x.a + .missing + 1.5' }], read))).toBe(
      '1 + 2 + #.a + $lib.a + x.a + .missing + 1.5',
    );
  });

  it('solves a formula with its parts, in the order their tags finished', () => {
    expect(
      solve('8 + Proficiency + STR or DEX', [
        { label: 'Proficiency', value: 3 },
        { label: 'STR or DEX', value: -1 },
      ]),
    ).toSatisfy((segments: Segment[]) => solvedText(segments) === '8 + 3 + -1');
    // An inner tag finishes before the outer one around it, and is not in the formula.
    expect(
      solve('Bonus + DEX', [
        { label: 'DEX', value: 1 },
        { label: 'Bonus', value: 4 },
        { label: 'DEX', value: 2 },
      ]),
    ).toSatisfy((segments: Segment[]) => solvedText(segments) === '4 + 2');
    // A tag a conditional skipped has no part, so its label stays; so does a longer name holding a label.
    expect(solvedText(solve('10 + DEX + Level + DEXTERITY', [{ label: 'DEX', value: 2 }]))).toBe(
      '10 + 2 + Level + DEXTERITY',
    );
    expect(solve('10', [])).toEqual([{ text: '10' }]);
    expect(solvedText(solve('10', []))).toBeUndefined();
  });

  it('gives each label a hue, the same one wherever it repeats', () => {
    expect(
      solve('DEX + PB + DEX', [
        { label: 'DEX', value: 1 },
        { label: 'PB', value: 3 },
        { label: 'DEX', value: 1 },
      ]),
    ).toEqual([
      { label: 'DEX', value: 1, hue: 0 },
      { text: ' + ' },
      { label: 'PB', value: 3, hue: 1 },
      { text: ' + ' },
      { label: 'DEX', value: 1, hue: 0 },
    ]);
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
    // Members are in, but nobody has rolled: no order yet.
    expect(combatOf({ combat: { rolls: {}, initiative: {}, order: [], round: 1 } })?.rolled).toBe(false);
    const roll = (value: number, dex: number) => ({
      ':value': value + dex,
      ':formula': 'd20 + Initiative',
      ':parts': [
        { ':label': 'd20', ':value': value },
        { ':label': 'Initiative', ':value': dex },
      ],
    });
    const data = {
      combat: {
        rolls: { aria: { initiative: roll(12, 2) }, bram: { initiative: roll(16, 1) } },
        initiative: { aria: 14, bram: 17 },
        order: ['bram', 'aria'],
        current: 'aria',
        round: { ':value': 2, ':events': [] },
      },
    };
    const combat = combatOf(data);
    expect(combat).toMatchObject({
      round: 2,
      current: 'aria',
      rolled: true,
      order: [
        { key: 'bram', initiative: 17 },
        { key: 'aria', initiative: 14 },
      ],
    });
    // Each initiative solves from the roll that was logged.
    expect(combat?.order[1]?.formula).toEqual({
      formula: 'd20 + Initiative',
      segments: [{ label: 'd20', value: 12, hue: 0 }, { text: ' + ' }, { label: 'Initiative', value: 2, hue: 1 }],
    });
  });

  it('reads a field’s events, skipping a first one that only declared an empty slot', () => {
    const fighter = { ':source': 'class/fighter/fighter.yaml', ':line': 7, ':set': 12 };
    const character = {
      hit_points: { current: { ':value': 12, ':events': [{ ':source': 'character.yaml', ':set': 8 }, fighter] } },
      hit_die: {
        ':value': 'd10',
        ':events': [{ ':set': { ':doc': 'filled by your class', ':type': 'die' } }, fighter],
      },
      armor: { ':value': ['shields'], ':events': [{ ':set': [] }, fighter] },
      features: { second_wind: { ':label': 'Second Wind', ':events': [{ ':add': 'second_wind' }] } },
      level: 5,
    };
    expect(eventsAt(character, 'hit_points.current')).toHaveLength(2);
    expect(eventsAt(character, 'hit_die')).toEqual([fighter]);
    expect(eventsAt(character, 'armor')).toEqual([fighter]);
    expect(eventsAt(character, 'features.second_wind')).toEqual([{ ':add': 'second_wind' }]);
    expect(eventsAt(character, 'level')).toEqual([]);
    expect(eventsAt(character, 'missing.deeper')).toEqual([]);
  });

  it('describes what an event did and where it came from', () => {
    expect(describeEvent({ ':set': 12 })).toBe('set to 12');
    expect(describeEvent({ ':set': ['all_armor', 'shields'] })).toBe('set to All armor, Shields');
    expect(describeEvent({ ':add': 1 })).toBe('+1');
    expect(describeEvent({ ':add': ['darkvision'] })).toBe('added Darkvision');
    expect(describeEvent({ ':add': 'second_wind' })).toBe('added');
    expect(describeEvent({ ':subtract': 1 })).toBe('−1');
    expect(describeEvent({ ':roll': '1d20', ':faces': [14] })).toBe('rolled 1d20: 14');
    expect(sourceOf({ ':roll': '1d20', ':faces': [14], ':version': 4 })).toBe('turn 4');

    expect(sourceOf({ ':source': 'class/fighter/fighter.yaml', ':line': 7, ':set': 12 })).toBe(
      'class/fighter/fighter.yaml:7',
    );
    expect(sourceOf({ ':source': 'override', ':version': 4, ':set': 35 })).toBe('override (turn 4)');
    expect(sourceOf({ ':source': 'class/fighter/fighter.yaml', ':subtract': 1 })).toBe('class/fighter/fighter.yaml');
    expect(sourceOf({ ':set': 1 })).toBe('unknown');
  });

  it('maps derived fields under the character to their expressions', () => {
    const node = (path: string, kind: InspectNode['kind'], expression?: string, value?: unknown): InspectNode => ({
      path,
      key: path.split('.').at(-1) ?? path,
      kind,
      expression,
      value,
      reads: [],
      children: [],
      private: false,
    });
    const derived = expressionsOf(
      [
        node('party.aria.armor_class', 'expression', '10 + .abilities.dexterity.modifier', 11),
        node('party.aria.hit_die', 'expression', 'd10', 'd10'),
        node('party.aria.rest.long', 'function', '() => @.hit_points.current = @.hit_points.max'),
        node('party.aria.speed', 'value', undefined, 30),
        node('party.bram.armor_class', 'expression', '10 + .abilities.dexterity.modifier', 12),
      ],
      'party.aria',
    );
    expect([...derived]).toEqual([['armor_class', '10 + .abilities.dexterity.modifier']]);
  });
});
