import { G } from '../G';
import { Character } from './character';

export const Game = G.scope({
  characters: G.scope({
    allies: G.record(G.string(), Character),
  }),
});

export const Encounter = G.scope({
  party: G.record(G.string(), Character),
});

export const Turn = G.scope({
  encounter: Encounter,
  actor: Character,
});

export const Attack = G.scope({
  turn: Turn,
});
