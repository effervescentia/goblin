import { DIE_LITERAL } from '../constants';
import { Node } from './node';

/** A die value: arithmetic rolls it, a standalone literal keeps its spec. */
/** Where a face is rolled: it may hand back a recorded face instead of a fresh one. */
export interface RollFrame {
  face(sides: number): number;
}

export class Die {
  /** Faces rolled so far, process-wide: a value computed while it rose came from dice. */
  static rolled = 0;

  /** Open roll frames, innermost last (evaluation is synchronous, so one stack serves). */
  private static readonly frames: RollFrame[] = [];

  /** One face of a `sides`-sided die. Every roll goes through here. */
  static face(sides: number): number {
    Die.rolled++;
    const frame = Die.frames.at(-1);
    return frame === undefined ? Die.fresh(sides) : frame.face(sides);
  }

  static fresh(sides: number): number {
    return 1 + Math.floor(Math.random() * sides);
  }

  /** Run `body` with `frame` answering its rolls. */
  static within<T>(frame: RollFrame, body: () => T): T {
    Die.frames.push(frame);
    try {
      return body();
    } finally {
      Die.frames.pop();
    }
  }

  /** The frame `body` would roll in, for one that passes rolls outward. */
  static current(): RollFrame | undefined {
    return Die.frames.at(-1);
  }

  constructor(
    public readonly count: number,
    public readonly sides: number,
    private readonly label?: string,
  ) {}

  roll(): number {
    return this.rolls().reduce((total, face) => total + face, 0);
  }

  /** Each die's face, for rules that read them apart (drop the lowest). */
  rolls(): number[] {
    return Array.from({ length: this.count }, () => Die.face(this.sides));
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

  override debug(): string {
    return this.raw.toString();
  }

  override evaluate(): unknown {
    return this.raw;
  }
}
