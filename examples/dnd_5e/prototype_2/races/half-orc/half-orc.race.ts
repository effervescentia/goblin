import { Character } from '../../character';
import { Ability, Size } from '../../common';
import { Race } from '../../race';
import {
  Languages,
  Menacing,
  RelentlessEndurance,
  SavageAttacks,
} from './half-orc.power';

export const HalfOrc = Race.impl({
  powers: [Menacing, RelentlessEndurance, SavageAttacks, Languages],
}).effects(
  Character.ModifyAbility(Ability.$.STRENGTH, 2),
  Character.ModifyAbility(Ability.$.CONSTITUTION, 1),
  Character.Size(Size.$.MEDIUM),
  Character.WalkSpeed(30),
  Character.Darkvision(60),
);
