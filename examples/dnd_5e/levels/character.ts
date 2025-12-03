import { G } from '../G';

export const Spell = G.struct({ name: G.string() });

export const Level = G.struct({ xp: G.number() });

export const Character = G.struct({
  xp: G.number(),
  spells: Spell.array(),
}).mutators({
  Spell: ($) => (power: G.ImplOf<typeof Spell>) =>
    G.assign($.spells, G.expr.append($.spells, power)),
});

const Fireball = Spell.impl({ name: 'Fireball' });
const MagicMissile = Spell.impl({ name: 'Magic Missile' });
const ScorchingRay = Spell.impl({ name: 'Scorching Ray' });
const Invisibility = Spell.impl({ name: 'Invisibility' });
const Teleport = Spell.impl({ name: 'Teleport' });

export const Level_1 = Level.impl({ xp: 0 }).effects(Character.Spell(Fireball));
export const Level_2 = Level.impl({ xp: 100 }).effects(
  Character.Spell(MagicMissile),
);
export const Level_3 = Level.impl({ xp: 500 }).effects(
  Character.Spell(ScorchingRay),
);
export const Level_4 = Level.impl({ xp: 2000 }).effects(
  Character.Spell(Invisibility),
);
export const Level_5 = Level.impl({ xp: 10000 }).effects(
  Character.Spell(Teleport),
);
