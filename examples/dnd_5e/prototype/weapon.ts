import { WeaponCategory } from './common';

export abstract class Weapon {
  abstract category: WeaponCategory;

  ranged = false;
}

export class Battleaxe extends Weapon {
  category = WeaponCategory.MARTIAL;
}

export class Handaxe extends Weapon {
  category = WeaponCategory.SIMPLE;
}

export class HandCrossbow extends Weapon {
  category = WeaponCategory.MARTIAL;

  ranged = true;
}

export class LightHammer extends Weapon {
  category = WeaponCategory.SIMPLE;
}

export class Longbow extends Weapon {
  category = WeaponCategory.MARTIAL;

  ranged = true;
}

export class Longsword extends Weapon {
  category = WeaponCategory.MARTIAL;
}

export class Rapier extends Weapon {
  category = WeaponCategory.MARTIAL;
}

export class Shortbow extends Weapon {
  category = WeaponCategory.SIMPLE;

  ranged = true;
}

export class Shortsword extends Weapon {
  category = WeaponCategory.SIMPLE;
}

export class Warhammer extends Weapon {
  category = WeaponCategory.MARTIAL;
}
