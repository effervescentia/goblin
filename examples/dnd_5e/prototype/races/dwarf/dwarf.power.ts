import { ArmorCategory } from '../../common';
import { Choice, DamageResistance, DamageType } from '../../modifier';
import { Power } from '../../power';
import {
  ArmorCategoryProficiency,
  ToolProficiency,
  WeaponProficiency,
} from '../../proficiency';
import { BrewersSupplies, MasonsTools, SmithsTools } from '../../tool';
import { Battleaxe, Handaxe, LightHammer, Warhammer } from '../../weapon';

export class DwarvenResilience extends Power {
  // TODO: Add advantage on saving throws against poison
  modifiers = [new DamageResistance(DamageType.POISON)];
}

export class DwarvenCombatTraining extends Power {
  modifiers = [
    new WeaponProficiency(Battleaxe),
    new WeaponProficiency(Handaxe),
    new WeaponProficiency(LightHammer),
    new WeaponProficiency(Warhammer),
  ];
}

export class DwarvenTools extends Power {
  modifiers = [
    new Choice([
      new ToolProficiency(SmithsTools),
      new ToolProficiency(BrewersSupplies),
      new ToolProficiency(MasonsTools),
    ]),
  ];
}

export class Stonecunning extends Power {
  // TODO: Add advantage on Intelligence (History) checks related to the origin of stonework with double proficiency bonus
}

export class DwarvenToughness extends Power {
  // TODO: Add +1 hit point per level
}

export class DwarvenArmorTraining extends Power {
  modifiers = [
    new ArmorCategoryProficiency(ArmorCategory.LIGHT),
    new ArmorCategoryProficiency(ArmorCategory.MEDIUM),
  ];
}
