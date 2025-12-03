import { Character } from '../../character';
import { Ability, Size } from '../../common';
import { Race } from '../../race';
import { HellishResistance, InfernalLegacy, Languages } from './tiefling.power';

export const Tiefling = Race.impl({
  powers: [HellishResistance, InfernalLegacy, Languages],
}).effects(
  Character.ModifyAbility(Ability.$.CHARISMA, 2),
  Character.ModifyAbility(Ability.$.INTELLIGENCE, 1),
  Character.Size(Size.$.MEDIUM),
  Character.WalkSpeed(30),
  Character.Darkvision(60),
);
