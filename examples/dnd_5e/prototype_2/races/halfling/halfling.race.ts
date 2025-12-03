import { Character } from '../../character';
import { Ability, Size } from '../../common';
import { Race } from '../../race';
import {
  Brave,
  HalflingNimbleness,
  Languages,
  Lucky,
  NaturallyStealthy,
  StoutResilience,
} from './halfling.power';

export const Halfling = Race.impl({
  powers: [Lucky, Brave, HalflingNimbleness, Languages],
}).effects(
  Character.ModifyAbility(Ability.$.DEXTERITY, 2),
  Character.Size(Size.$.SMALL),
  Character.WalkSpeed(25),
);

export const LightfootHalfling = Halfling.mixin((base) => ({
  ...base,

  powers: [...base.powers, NaturallyStealthy],
})).effects(Character.ModifyAbility(Ability.$.CHARISMA, 1));

export const StoutHalfling = Halfling.mixin((base) => ({
  ...base,

  powers: [...base.powers, StoutResilience],
})).effects(Character.ModifyAbility(Ability.$.CONSTITUTION, 1));
