import { Character } from '../../character';
import { Ability, Size } from '../../common';
import { Race } from '../../race';
import {
  BreathWeapon,
  DamageResistance,
  DraconicAncestry,
  Languages,
} from './dragonborn.power';

export const Dragonborn = Race.impl({
  powers: [DraconicAncestry, BreathWeapon, DamageResistance, Languages],
}).effects(
  Character.ModifyAbility(Ability.$.STRENGTH, 2),
  Character.ModifyAbility(Ability.$.CHARISMA, 1),
  Character.Size(Size.$.MEDIUM),
  Character.WalkSpeed(30),
);
