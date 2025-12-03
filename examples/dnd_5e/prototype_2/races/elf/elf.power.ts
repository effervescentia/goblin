import { Character } from '../../character';
import { Language, Skill } from '../../common';
import { Power } from '../../power';

export const KeenSenses = Power.impl({}).effects(
  Character.SkillProficiency(Skill.$.PERCEPTION),
);

export const FeyAncestry = Power.impl({}).effects();

export const Trance = Power.impl({}).effects();

export const Languages = Power.impl({}).effects(
  Character.LearnLanguage(Language.$.COMMON),
  Character.LearnLanguage(Language.$.ELVISH),
);

// high elf

export const HighElfWeaponTraining = Power.impl({}).effects();

export const Cantrip = Power.impl({}).effects();

export const ExtraLanguage = Power.impl({}).effects();

// wood elf

export const WoodElfWeaponTraining = Power.impl({}).effects();

export const FleetOfFoot = Power.impl({}).effects();

export const MaskOfTheWild = Power.impl({}).effects();

// drow

export const SuperiorDarkvision = Power.impl({}).effects(
  Character.Darkvision(120),
);

export const SunlightSensitivity = Power.impl({}).effects();

export const DrowMagic = Power.impl({}).effects();

export const DrowWeaponTraining = Power.impl({}).effects();
