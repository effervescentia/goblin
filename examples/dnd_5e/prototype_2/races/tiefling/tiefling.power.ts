import { Character } from '../../character';
import { Language } from '../../common';
import { Power } from '../../power';

export const HellishResistance = Power.impl({}).effects();

export const InfernalLegacy = Power.impl({}).effects();

export const Languages = Power.impl({}).effects(
  Character.LearnLanguage(Language.$.COMMON),
  Character.LearnLanguage(Language.$.INFERNAL),
);
