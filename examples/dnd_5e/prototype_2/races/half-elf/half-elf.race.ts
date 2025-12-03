import { Character } from '../../character';
import { Ability, Size } from '../../common';
import { Race } from '../../race';
import { FeyAncestry, Languages, SkillVersatility } from './half-elf.power';

export const HalfElf = Race.impl({
  powers: [FeyAncestry, SkillVersatility, Languages],
}).effects(
  Character.ModifyAbility(Ability.$.CHARISMA, 2),
  Character.Size(Size.$.MEDIUM),
  Character.WalkSpeed(30),
  Character.Darkvision(60),
);
