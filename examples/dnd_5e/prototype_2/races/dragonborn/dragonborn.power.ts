import { Character } from '../../character';
import { Language } from '../../common';
import { Power } from '../../power';

export const DraconicAncestry = Power.impl({}).effects();

export const BreathWeapon = Power.impl({}).effects();

export const DamageResistance = Power.impl({}).effects();

export const Languages = Power.impl({}).effects(
  Character.LearnLanguage(Language.$.COMMON),
  Character.LearnLanguage(Language.$.DRACONIC),
);
