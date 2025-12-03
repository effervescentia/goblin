import { Character } from '../../character';
import { Language } from '../../common';
import { Power } from '../../power';

export const Menacing = Power.impl({}).effects();

export const RelentlessEndurance = Power.impl({}).effects();

export const SavageAttacks = Power.impl({}).effects();

export const Languages = Power.impl({}).effects(
  Character.LearnLanguage(Language.$.COMMON),
  Character.LearnLanguage(Language.$.ORC),
);
