import { DIE_LITERAL } from '../constants';
import { Node } from './node';

/** A die value: arithmetic rolls it, a standalone literal keeps its spec. */
export class Die {
  constructor(
    public readonly count: number,
    public readonly sides: number,
    private readonly label?: string,
  ) {}

  roll(): number {
    let total = 0;
    for (let i = 0; i < this.count; i++) {
      total += 1 + Math.floor(Math.random() * this.sides);
    }
    return total;
  }

  /** Arithmetic with a die rolls it (`hit_points + hit_die`). */
  valueOf(): number {
    return this.roll();
  }

  [Symbol.toPrimitive](hint: string): string | number {
    return hint === 'string' ? this.toString() : this.roll();
  }

  toString(): string {
    return this.label ?? `${this.count > 1 ? this.count : ''}d${this.sides}`;
  }
}

/** A standalone `dN` / `NdM` spec: returned, never rolled. */
export class DieNode extends Node<Die> {
  /** Whole-string die literal (`d6`, `2d6`) — not inline dice. */
  static isLiteral(s: string): boolean {
    return DIE_LITERAL.test(s.trim());
  }

  /** Parse a die literal into its spec; null when the string is not one. */
  static parse(s: string): Die | null {
    const m = s.trim().match(DIE_LITERAL);
    if (!m) return null;
    const count = m[1] ? Number(m[1]) : 1;
    return new Die(count, Number(m[2]), s.trim());
  }

  /** Classify a raw value: an existing spec, or a string that spells one. */
  static match(raw: unknown): DieNode | null {
    if (raw instanceof Die) return new DieNode(raw);
    if (typeof raw === 'string') {
      const die = DieNode.parse(raw);
      if (die) return new DieNode(die);
    }
    return null;
  }

  /** Printed form: the spec as written (`d6`, `2d8`), never a roll. */
  static serialize(die: Die): string {
    return die.toString();
  }

  override evaluate(): unknown {
    return this.raw;
  }
}
