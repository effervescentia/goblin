import { Character } from '../../character';
import { Ability, Size } from '../../common';
import { Race } from '../../race';
import {
  DwarvenArmorTraining,
  DwarvenCombatTraining,
  DwarvenResilience,
  DwarvenToughness,
  Languages,
  Stonecunning,
  ToolProficiency,
} from './dwarf.power';

export const Dwarf = Race.impl({
  powers: [
    DwarvenResilience,
    DwarvenCombatTraining,
    ToolProficiency,
    Stonecunning,
    Languages,
  ],
}).effects(
  Character.ModifyAbility(Ability.$.CONSTITUTION, 2),
  Character.Size(Size.$.MEDIUM),
  Character.WalkSpeed(25),
  Character.Darkvision(60),
);

export const HillDwarf = Dwarf.mixin((base) => ({
  ...base,

  powers: [...base.powers, DwarvenToughness],
})).effects(Character.ModifyAbility(Ability.$.WISDOM, 1));

export const MountainDwarf = Dwarf.mixin((base) => ({
  ...base,

  powers: [...base.powers, DwarvenArmorTraining],
})).effects(Character.ModifyAbility(Ability.$.STRENGTH, 2));
