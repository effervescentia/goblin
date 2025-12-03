import { Ability, Language, Size } from '../../common';
import { Darkvision, Property, WalkSpeed } from '../../property';
import { Race, SubRace } from '../../race';
import {
  DrowMagic,
  DrowWeaponTraining,
  ElfWeaponTraining,
  FleetOfFoot,
  KeenSenses,
  MaskOfTheWild,
  SunlightSensitivity,
  SuperiorDarkvision,
} from './elf.power';

export class Elf extends Race {
  abilities = {
    [Ability.DEXTERITY]: 2,
  };

  languages = [Language.COMMON, Language.ELVISH];

  size = Size.MEDIUM;

  walk_speed = new WalkSpeed(30);

  properties = [new Darkvision(60)];

  powers = [KeenSenses];

  subraces = [HighElf, WoodElf, DarkElf];
}

export class HighElf extends SubRace {
  abilities = {
    [Ability.INTELLIGENCE]: 1,
  };

  powers = [ElfWeaponTraining];
}

export class WoodElf extends SubRace {
  abilities = {
    [Ability.WISDOM]: 1,
  };

  powers = [ElfWeaponTraining, FleetOfFoot, MaskOfTheWild];
}

export class DarkElf extends SubRace {
  abilities = {
    [Ability.CHARISMA]: 1,
  };

  powers = [
    SuperiorDarkvision,
    SunlightSensitivity,
    DrowMagic,
    DrowWeaponTraining,
  ];
}
