import { Ability } from './common';
import { Frequency } from './frequency';
import { Property } from './property';
import { Spell } from './spell';

export enum DamageType {
  POISON = 'poison',
}

export type SpellConstructor = { new (): Spell };

export abstract class Modifier {}

export class DamageResistance extends Modifier {
  constructor(public type: DamageType) {
    super();
  }
}

export class Advantage extends Modifier {}

export class Choice extends Modifier {
  constructor(public options: Modifier[], public count = 1) {
    super();
  }
}

export class OverrideProperty extends Modifier {
  constructor(public property: Property) {
    super();
  }
}

export class AtLevel extends Modifier {
  constructor(public level: number, public modifier: Modifier) {
    super();
  }
}

export class Spellcasting extends Modifier {
  constructor(
    public ability: Ability,
    public spell: SpellConstructor,
    public frequency: Frequency | null = null,
  ) {
    super();
  }
}
