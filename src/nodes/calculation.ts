import { FORMULA_KEY, PARAM_VALUE_KEY, PARTS_KEY } from '@/constants';

/** A labelled value kept with how it was worked out: arithmetic reads its `:value`, and its own keys are the
 * `{ :value, :formula, :parts }` a labelled field prints as, so writing it into data stores that record. */
export class Calculation {
  readonly [PARAM_VALUE_KEY]: unknown;
  readonly [FORMULA_KEY]: string | undefined;
  readonly [PARTS_KEY]: Record<string, unknown>[];

  constructor(value: unknown, formula: string | undefined, parts: Record<string, unknown>[]) {
    this[PARAM_VALUE_KEY] = value;
    this[FORMULA_KEY] = formula;
    this[PARTS_KEY] = parts;
  }

  valueOf(): unknown {
    return this[PARAM_VALUE_KEY];
  }

  toString(): string {
    return String(this[PARAM_VALUE_KEY]);
  }
}
