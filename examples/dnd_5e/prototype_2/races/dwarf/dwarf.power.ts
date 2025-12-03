import { G } from '../../../G';
import { Character } from '../../character';
import { ArmorCategory, Language } from '../../common';
import { Power } from '../../power';
import { Battleaxe, Handaxe, LightHammer, Warhammer } from '../../weapons';

export const DwarvenResilience = Power.impl({}).effects();

export const DwarvenCombatTraining = Power.impl({}).effects(
  Character.WeaponProficiency(Battleaxe),
  Character.WeaponProficiency(Handaxe),
  Character.WeaponProficiency(LightHammer),
  Character.WeaponProficiency(Warhammer),
);

export const ToolProficiency = Power.impl({}).effects();

export const Stonecunning = Power.impl({}).effects();

export const Languages = Power.impl({}).effects(
  Character.LearnLanguage(Language.$.COMMON),
  Character.LearnLanguage(Language.$.DWARVISH),
);

// hill dwarf

export const DwarvenToughness = Power.impl({}).effects(
  Character.mutate(($) => G.assign($.max_hp, G.expr.add($.max_hp, $.level))),
);

// mountain dwarf

export const DwarvenArmorTraining = Power.impl({}).effects(
  Character.ArmorCategoryProficiency(ArmorCategory.$.LIGHT),
  Character.ArmorCategoryProficiency(ArmorCategory.$.MEDIUM),
);
