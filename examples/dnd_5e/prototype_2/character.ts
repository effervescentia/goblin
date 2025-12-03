import { G } from '../G';
import { Armor } from './armor';
import {
  Ability,
  ArmorCategory,
  Language,
  Size,
  Skill,
  WeaponCategory,
} from './common';
import { Weapon } from './weapons';

export const Character = G.struct({
  size: Size,

  walk_speed: G.number(),

  darkvision: G.number(),

  languages: Language.array(),

  abilities: G.record(Ability, G.number()),

  skills: G.record(
    Skill,
    G.object({
      value: G.number(),
      proficient: G.boolean(),
    }),
  ),

  proficiencies: G.object({
    tools: G.number(),

    weapon_categories: WeaponCategory.array(),

    weapons: Weapon.array(),

    armor_categories: ArmorCategory.array(),

    armor: Armor.array(),
  }),

  max_hp: G.number(),

  level: G.number(),
}).mutators({
  ModifyAbility: ($) => (ability: G.TypeOf<typeof Ability>, value: number) =>
    G.assign($.abilities[ability], G.expr.add($.abilities[ability], value)),

  LearnLanguage: ($) => (language: G.TypeOf<typeof Language>) =>
    G.assign($.languages, G.expr.include($.languages, language)),

  WalkSpeed: ($) => (speed: number) => G.assign($.walk_speed, speed),

  Size: ($) => (size: G.TypeOf<typeof Size>) => G.assign($.size, size),

  Darkvision: ($) => (distance: number) => G.assign($.darkvision, distance),

  SkillProficiency: ($) => (skill: G.TypeOf<typeof Skill>) =>
    G.assign($.skills[skill].proficient, true),

  WeaponProficiency: ($) => (weapon: G.TypeOf<typeof Weapon>) =>
    G.assign(
      $.proficiencies.weapons,
      G.expr.include($.proficiencies.weapons, weapon),
    ),

  WeaponCategoryProficiency:
    ($) => (category: G.TypeOf<typeof WeaponCategory>) =>
      G.assign(
        $.proficiencies.weapon_categories,
        G.expr.include($.proficiencies.weapon_categories, category),
      ),

  ArmorProficiency: ($) => (armor: G.TypeOf<typeof Armor>) =>
    G.assign(
      $.proficiencies.armor,
      G.expr.include($.proficiencies.armor, armor),
    ),

  ArmorCategoryProficiency: ($) => (category: G.TypeOf<typeof ArmorCategory>) =>
    G.assign(
      $.proficiencies.armor_categories,
      G.expr.include($.proficiencies.armor_categories, category),
    ),
});
