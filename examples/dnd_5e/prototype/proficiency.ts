import { Armor } from './armor';
import { ArmorCategory, Skill, WeaponCategory } from './common';
import { Modifier } from './modifier';
import { Tool } from './tool';
import { Weapon } from './weapon';

export type ArmorConstructor = { new (): Armor };
export type WeaponConstructor = { new (): Weapon };
export type ToolConstructor = { new (): Tool };

export abstract class Proficiency extends Modifier {}

export class ArmorProficiency extends Proficiency {
  constructor(public armor: ArmorConstructor) {
    super();
  }
}

export class ArmorCategoryProficiency extends Proficiency {
  constructor(public type: ArmorCategory) {
    super();
  }
}

export class WeaponProficiency extends Proficiency {
  constructor(public weapon: WeaponConstructor) {
    super();
  }
}

export class WeaponCategoryProficiency extends Proficiency {
  constructor(public type: WeaponCategory) {
    super();
  }
}

export class ToolProficiency extends Proficiency {
  constructor(public weapon: ToolConstructor) {
    super();
  }
}

export class SkillProficiency extends Proficiency {
  constructor(public skill: Skill) {
    super();
  }
}
