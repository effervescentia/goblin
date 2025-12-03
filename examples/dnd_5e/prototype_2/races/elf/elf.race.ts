import { Character } from '../../character';
import { Ability, Size } from '../../common';
import { Race } from '../../race';
import {
  Cantrip,
  DrowMagic,
  DrowWeaponTraining,
  ExtraLanguage,
  FeyAncestry,
  FleetOfFoot,
  HighElfWeaponTraining,
  KeenSenses,
  Languages,
  MaskOfTheWild,
  SunlightSensitivity,
  SuperiorDarkvision,
  Trance,
  WoodElfWeaponTraining,
} from './elf.power';

export const Elf = Race.impl({
  powers: [KeenSenses, FeyAncestry, Trance, Languages],
}).effects(
  Character.ModifyAbility(Ability.$.DEXTERITY, 2),
  Character.Size(Size.$.MEDIUM),
  Character.WalkSpeed(30),
  Character.Darkvision(60),
);

export const HighElf = Elf.mixin((base) => ({
  ...base,

  powers: [...base.powers, HighElfWeaponTraining, Cantrip, ExtraLanguage],
})).effects(Character.ModifyAbility(Ability.$.INTELLIGENCE, 1));

export const WoodElf = Elf.mixin((base) => ({
  ...base,

  powers: [...base.powers, WoodElfWeaponTraining, FleetOfFoot, MaskOfTheWild],
})).effects(Character.ModifyAbility(Ability.$.WISDOM, 1));

export const Drow = Elf.mixin((base) => ({
  ...base,

  powers: [
    ...base.powers,
    SuperiorDarkvision,
    SunlightSensitivity,
    DrowMagic,
    DrowWeaponTraining,
  ],
})).effects(Character.ModifyAbility(Ability.$.CHARISMA, 1));
