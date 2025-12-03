interface Scope {
  readonly __scope: unique symbol;
}

interface Game extends Scope {
  characters: {
    allies: {
      alex: Character;
    };
  };
}

interface Encounter extends Scope {
  party: {
    alex: Character;
  };
}

interface Turn extends Scope {
  encounter: Encounter;
  actor: Character; // (alex)
}

interface Action extends Scope {
  turn: Turn;
}

interface Attack extends Scope {
  turn: Turn;
}

type Size = 'small' | 'medium';

// struct instance
interface Character {
  race: Race;
  name: string;
  hp: number;
  ac: number;
  size: Size;
  walk_speed: number;
}

type CharacterFactory = (race: Race) => Character;

// struct instance
interface Race {
  size: Size;
  walk_speed: number;
}

// this is how everything gets done
// only the top scope in the stack is active
// only one scope of each type can be in the stack
type ExecutionStack = Scope[];
