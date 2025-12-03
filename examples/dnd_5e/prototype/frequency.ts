export abstract class Frequency {}

export class AtWill extends Frequency {}

export class PerDay extends Frequency {
  constructor(public uses: number) {
    super();
  }
}
