import { Character } from '../../character';
import { Language } from '../../common';
import { Power } from '../../power';

export const FeyAncestry = Power.impl({}).effects();

export const SkillVersatility = Power.impl({}).effects();

export const Languages = Power.impl({}).effects(
  Character.LearnLanguage(Language.$.COMMON),
  Character.LearnLanguage(Language.$.ELVISH),
);
