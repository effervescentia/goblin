import { Ability, Skill } from '../../common';
import { PerDay } from '../../frequency';
import {
  AtLevel,
  Modifier,
  OverrideProperty,
  Spellcasting,
} from '../../modifier';
import { Power } from '../../power';
import { SkillProficiency, WeaponProficiency } from '../../proficiency';
import { Darkvision, WalkSpeed } from '../../property';
import { DancingLights, Darkness, FaerieFire } from '../../spell';
import {
  HandCrossbow,
  Longbow,
  Longsword,
  Rapier,
  Shortbow,
  Shortsword,
} from '../../weapon';

export class KeenSenses extends Power {
  modifiers = [new SkillProficiency(Skill.PERCEPTION)];
}

export class FleetOfFoot extends Power {
  modifiers = [new OverrideProperty(new WalkSpeed(35))];
}

export class MaskOfTheWild extends Power {
  // TODO: able to hide when lightly obscured by natural phenomena
}

export class SuperiorDarkvision extends Power {
  modifiers = [new OverrideProperty(new Darkvision(120))];
}

export class SunlightSensitivity extends Power {
  // TODO: disadvantage on attack rolls and Wisdom (Perception) checks that rely on sight when in direct sunlight
}

export class DrowMagic extends Power {
  modifiers = [
    new Spellcasting(Ability.CHARISMA, DancingLights),
    new AtLevel(
      3,
      new Spellcasting(Ability.CHARISMA, FaerieFire, new PerDay(1)),
    ),
    new AtLevel(5, new Spellcasting(Ability.CHARISMA, Darkness, new PerDay(1))),
  ];
}

export class ElfWeaponTraining extends Power {
  modifiers = [
    new WeaponProficiency(Longsword),
    new WeaponProficiency(Shortsword),
    new WeaponProficiency(Shortbow),
    new WeaponProficiency(Longbow),
  ];
}

export class DrowWeaponTraining extends Power {
  modifiers = [
    new WeaponProficiency(Rapier),
    new WeaponProficiency(Shortsword),
    new WeaponProficiency(HandCrossbow),
  ];
}
