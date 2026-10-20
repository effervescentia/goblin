/** `$lib.math` — bound in code, so it is there before any document loads. */
export const MATH_LIB: Record<string, (...args: number[]) => number> = {
  floor: (n: number) => Math.floor(n),
  ceil: (n: number) => Math.ceil(n),
  round: (n: number) => Math.round(n),
  abs: (n: number) => Math.abs(n),
  min: (...ns: number[]) => Math.min(...ns),
  max: (...ns: number[]) => Math.max(...ns),
};
