import { G } from '../G';

export const Ability = G.enum([
  'STRENGTH',
  'DEXTERITY',
  'CONSTITUTION',
  'INTELLIGENCE',
  'WISDOM',
  'CHARISMA',
]);

export const Skill = G.enum([
  // strength
  'ATHLETICS',

  // dexterity
  'ACROBATICS',
  'SLEIGHT_OF_HAND',
  'STEALTH',

  // intelligence
  'ARCANA',
  'HISTORY',
  'INVESTIGATION',
  'NATURE',
  'RELIGION',

  // wisdom
  'ANIMAL_HANDLING',
  'INSIGHT',
  'MEDICINE',
  'PERCEPTION',
  'SURVIVAL',

  // charisma
  'DECEPTION',
  'INTIMIDATION',
  'PERFORMANCE',
  'PERSUASION',
]);

export const Size = G.enum(['SMALL', 'MEDIUM']);

export const Language = G.enum([
  'COMMON',
  'DRACONIC',
  'DWARVISH',
  'ELVISH',
  'GNOMISH',
  'HALFLING',
  'INFERNAL',
  'ORC',
]);

export const ArmorCategory = G.enum(['LIGHT', 'MEDIUM', 'HEAVY', 'SHIELD']);

export const WeaponCategory = G.enum(['SIMPLE', 'MARTIAL']);

export const ArtisanTool = G.enum([
  'SMITHS_TOOLS',
  'BREWERS_SUPPLIES',
  'MASONS_TOOLS',
]);
