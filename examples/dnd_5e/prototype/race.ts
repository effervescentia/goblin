import { Ability, Language, Size } from './common';
import { Power } from './power';
import { Property, WalkSpeed } from './property';

export type AbilityImprovements = Partial<Record<Ability, number>>;
export type SubRaceConstructor = { new (): SubRace };
export type PowerConstructor = { new (): Power };

export abstract class Race {
  abstract abilities: AbilityImprovements;

  abstract languages: Language[];

  abstract size: Size;

  walk_speed: WalkSpeed;

  properties: Property[] = [];

  powers: PowerConstructor[] = [];

  subraces: SubRaceConstructor[] = [];
}

export abstract class SubRace {
  abstract abilities: AbilityImprovements;

  properties: Property[] = [];

  powers: PowerConstructor[] = [];
}

export class Halfling extends Race {
  abilities = {
    [Ability.DEXTERITY]: 2,
  };

  size = Size.SMALL;

  walk_speed = new WalkSpeed(25);

  subraces = [LightfootHalfling, StoutHalfling];
}

export class LightfootHalfling extends SubRace {
  abilities = {
    [Ability.CHARISMA]: 1,
  };
}

export class StoutHalfling extends SubRace {
  abilities = {
    [Ability.CONSTITUTION]: 1,
  };
}
