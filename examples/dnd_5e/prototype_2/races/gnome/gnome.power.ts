import { Character } from '../../character';
import { Language } from '../../common';
import { Power } from '../../power';

export const GnomeCunning = Power.impl({}).effects();

export const Languages = Power.impl({}).effects(
  Character.LearnLanguage(Language.$.COMMON),
  Character.LearnLanguage(Language.$.GNOMISH),
);

// forest gnome

export const NaturalIllusionist = Power.impl({}).effects();

export const SpeakWithSmallBeasts = Power.impl({}).effects();

// rock gnome

export const ArtificersLore = Power.impl({}).effects();

export const Tinker = Power.impl({}).effects();
