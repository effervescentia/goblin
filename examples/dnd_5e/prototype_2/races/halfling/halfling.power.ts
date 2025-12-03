import { Character } from '../../character';
import { Language } from '../../common';
import { Power } from '../../power';

export const Lucky = Power.impl({}).effects();

export const Brave = Power.impl({}).effects();

export const HalflingNimbleness = Power.impl({}).effects();

export const Languages = Power.impl({}).effects(
  Character.LearnLanguage(Language.$.COMMON),
  Character.LearnLanguage(Language.$.HALFLING),
);

// lightfoot halfling

export const NaturallyStealthy = Power.impl({}).effects();

// stout halfling

export const StoutResilience = Power.impl({}).effects();
