export abstract class Property<T = unknown> {
  abstract value: T;
}

export class WalkSpeed extends Property<number> {
  constructor(public value: number) {
    super();
  }
}

export class Darkvision extends Property<number> {
  constructor(public value: number) {
    super();
  }
}
