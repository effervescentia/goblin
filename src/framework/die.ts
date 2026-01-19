export class Die {
  constructor(public readonly sides: number) {}

  public roll() {
    return ((Math.random() * 1000) % this.sides) + 1;
  }

  public toString(): string {
    return `d${this.sides}`;
  }
}

export class DieRoll {
  constructor(
    public readonly count: number,
    public readonly die: Die,
  ) {}

  public execute() {
    return new Array(this.count).reduce((acc) => acc + this.die.roll(), 0);
  }

  public toString(): string {
    return `${this.count}${this.die}`;
  }
}
