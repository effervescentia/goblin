import { Character } from '../../character';
import { Ability, Size } from '../../common';
import { Race } from '../../race';
import {
  ArtificersLore,
  GnomeCunning,
  Languages,
  NaturalIllusionist,
  SpeakWithSmallBeasts,
  Tinker,
} from './gnome.power';

export const Gnome = Race.impl({
  powers: [GnomeCunning, Languages],
}).effects(
  Character.ModifyAbility(Ability.$.INTELLIGENCE, 2),
  Character.Size(Size.$.SMALL),
  Character.WalkSpeed(25),
  Character.Darkvision(60),
);

export const ForestGnome = Gnome.mixin((base) => ({
  ...base,

  powers: [...base.powers, NaturalIllusionist, SpeakWithSmallBeasts],
})).effects(Character.ModifyAbility(Ability.$.DEXTERITY, 1));

export const RockGnome = Gnome.mixin((base) => ({
  ...base,

  powers: [...base.powers, ArtificersLore, Tinker],
})).effects(Character.ModifyAbility(Ability.$.CONSTITUTION, 1));
