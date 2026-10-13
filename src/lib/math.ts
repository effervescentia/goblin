/**
 * `$lib.math` — native numeric helpers, bound in code so they are available
 * before any document loads. Yaml helpers of the same name never shadow
 * these (see `GoblinEngine.mergeLib`).
 */
export const MATH_LIB: Record<string, (...args: number[]) => number> = {
  floor: (n: number) => Math.floor(n),
  ceil: (n: number) => Math.ceil(n),
  round: (n: number) => Math.round(n),
  abs: (n: number) => Math.abs(n),
  min: (...ns: number[]) => Math.min(...ns),
  max: (...ns: number[]) => Math.max(...ns),
};
