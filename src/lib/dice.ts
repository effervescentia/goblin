import { Die } from '@/nodes/die';

/** `$lib.dice` — rolls that read each die, which inline `NdM` (a plain sum)
 * cannot. Takes counts and sides, since inline dice roll before a call sees them. */
export const DICE_LIB: Record<string, (...args: never[]) => number> = {
  /** Roll `count`d`sides` and sum the `keep` highest: 4d6 drop lowest is (4, 6, 3). */
  keep_highest: (count: number, sides: number, keep: number) =>
    new Die(count, sides)
      .rolls()
      .sort((a, b) => b - a)
      .slice(0, keep)
      .reduce((total, face) => total + face, 0),
  /** The most `die` can roll, every face its top (`2d6` → 12). Give it a die field, not inline dice, which roll first. */
  max: (die: Die) => die.count * die.sides,
};
