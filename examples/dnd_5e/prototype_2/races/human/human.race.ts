import { Character } from '../../character';
import { Ability, Size } from '../../common';
import { Race } from '../../race';
import { Languages } from './human.power';

export const Human = Race.impl({
  powers: [Languages],
}).effects(
  ...Object.values(Ability.$).map((ability) =>
    Character.ModifyAbility(ability, 1),
  ),
  Character.Size(Size.$.MEDIUM),
  Character.WalkSpeed(30),
);
