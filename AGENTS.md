# AGENTS.md

Instructions for AI coding agents working in this repository.

## Runtime

This project uses **Bun** (not Node) as the runtime and package manager.
Use `bun <file>` to run scripts and `bun add` / `bun install` for dependencies.

## Validating changes

Always validate code changes with **both** of the following before finishing:

1. **Lint + types** — [Biome](https://biomejs.dev) for lint/format, `tsc` for types:
   ```sh
   bun run check
   ```
   This runs `check:format` (`biome check`) and `check:types` (`tsc --noEmit`).
   Fix all errors. Pre-existing style warnings (e.g. `noNonNullAssertion`) are acceptable;
   do not add new ones if avoidable. Use `bun run format` to auto-fix formatting.

2. **Tests** — [Vitest](https://vitest.dev):
   ```sh
   bun run test
   ```
   Tests live in `src/*.test.ts`. All tests must pass. Add or update tests when
   changing engine behavior in `src/engine.ts`.

## Syntax spec

`SYNTAX.md` is the living specification for the goblin `.yaml` syntax.
Whenever you add, change, or remove syntax (sigils, expressions, dice,
functions, patch keys, conditions, validation, or any other convention),
update `SYNTAX.md` in the same change so the spec and the engine never drift
apart. Treat a missing spec update as an incomplete change.

## Examples

- `examples/` must demonstrate every language feature from `SYNTAX.md`
  (one focused `NN-name.yaml` file per feature, plus actor/class pairs for
  applied-document syntax like path keys, `+` effects, and level blocks).
- Every example must stay runnable: `src/examples.test.ts` resolves each file
  through the real CLI and fails on non-zero exit or invalid JSON.
- When syntax changes, update `SYNTAX.md`, `src/engine.ts`, `examples/`, and
  the tests together — a feature without a working example is incomplete.

## Project notes

- `bun src/main.ts` (or `bun run dev`) runs the demo CLI, which loads
  `.goblin.yaml` → `wip/main.yaml` and logs evaluated output via pino.
  The final evaluated state always logs; diagnostics need `--debug`
  (validation failures always log as errors).
- `bun run build` compiles `src/cli.ts` to a `build/goblin` binary
  (`goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--help]`) that prints
  the resolution envelope (`{ data }` or `{ query }`) as JSON to stdout. `src/cli.ts` is Bun-only; keep `parseArgs` pure
  so `src/cli.test.ts` stays runtime-agnostic.
- `src/engine.ts` transpiles goblin expressions with `new Function` — every
  `.name` token is treated as a goblin ref, so avoid introducing bare JS
  property access in expression strings.
- `src/main.ts` is Bun-only (`Bun.file`, top-level await). Keep test fixtures
  in `src/engine.test.ts` runtime-agnostic by seeding `engine.docs` directly
  instead of using `loadFile`.

## Dependencies

- Pin **exact** versions in `package.json` — no `^`, `~`, or other ranges.
  Use `bun add --exact` (or `bun add -E`) so new dependencies are pinned too.

## Self-maintenance

When user feedback implies a new standing rule (a correction, preference, or
workflow constraint that should apply to future work), proactively prompt the
user with a concrete one-line rule proposal for `AGENTS.md` and add it once
confirmed. Corrections stay in effect for the rest of the session even before
they are written down.
