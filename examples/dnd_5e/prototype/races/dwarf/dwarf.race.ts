import { Ability, Language, Size } from '../../common';
import { Darkvision, WalkSpeed } from '../../property';
import { Race, SubRace } from '../../race';
import {
  DwarvenArmorTraining,
  DwarvenCombatTraining,
  DwarvenResilience,
  DwarvenTools,
  DwarvenToughness,
  Stonecunning,
} from './dwarf.power';

export class Dwarf extends Race {
  abilities = {
    [Ability.CONSTITUTION]: 2,
  };

  languages = [Language.COMMON, Language.DWARVISH];

  size = Size.MEDIUM;

  walk_speed = new WalkSpeed(25);

  properties = [new Darkvision(60)];

  powers = [
    DwarvenResilience,
    DwarvenCombatTraining,
    DwarvenTools,
    Stonecunning,
  ];

  subraces = [HillDwarf, MountainDwarf];
}

export class HillDwarf extends SubRace {
  abilities = {
    [Ability.WISDOM]: 1,
  };

  powers = [DwarvenToughness];
}

export class MountainDwarf extends SubRace {
  abilities = {
    [Ability.STRENGTH]: 2,
  };

  powers = [DwarvenArmorTraining];
}
