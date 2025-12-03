import { Character } from '../../character';
import { Language } from '../../common';
import { Power } from '../../power';

export const Languages = Power.impl({}).effects(
  Character.LearnLanguage(Language.$.COMMON),
);
