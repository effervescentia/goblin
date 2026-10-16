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

- `src/main.ts` exports `GoblinEngine`. The CLI uses `.goblin.yaml` from the
  current directory when no entry is provided.
  The final evaluated state always logs; diagnostics need `--debug`
  (validation failures always log as errors).
- `bun run build` compiles `src/cli.ts` to a `build/goblin` binary
  (`goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--in state.json|-] [--out file.json] [--help]`) that prints
  the resolution envelope (`{ hash, parameters, overrides, data }` — the run's inputs, with `hash` a `sha256:` of the compact JSON of the rest — `{ query }`, or `{ errors }` for failing `!validate` rules) as JSON to stdout, also writing it to `--out` when the document fully resolves. `--in` replays a prior output's `parameters` and `overrides` (`-` reads stdin). Keep serialized key order deterministic (same input → same order) — the
  `hash` is over `JSON.stringify`, so unstable ordering silently changes it. `src/cli.ts` is Bun-only; keep `parseArgs` pure
  so `src/cli.test.ts` stays runtime-agnostic.
- `bun run ui` serves the inspector (`ui/`, Bun-only) at localhost:3000: it
  resolves an entry via `resolveApp` in `src/cli.ts`, answers `{ query }`
  turns with a form, and renders `inspect()` (`src/inspect.ts`, pure) —
  fields, what each reads and is read by, and their `:events`.
- `src/engine.ts` transpiles goblin expressions with `new Function` — every
  `.name` token is treated as a goblin ref, so avoid introducing bare JS
  property access in expression strings.
- Keep test fixtures in `src/engine.test.ts` runtime-agnostic by seeding
  `engine.docs` directly instead of using `loadFile`.

## Code layout

- Node-specific utilities belong in `src/nodes/`, attached as static functions
  or methods on the node class they serve (e.g. `FunctionNode.match`,
  `DieNode.parse`, `RecordNode.collectParams`, each node's `serialize`) — not as
  loose helpers in `src/utils.ts`. Keep `src/utils.ts` for genuinely shared,
  node-agnostic code (refs, paths, expression compilation, serialization).
- The standard library (`$lib`) lives in `src/lib/`: one file per namespace
  (`math.ts`), listed in `src/lib/index.ts`, plus `src/lib/lib.yaml` for
  yaml-defined helpers. Natives always win over yaml of the same name.
- Only comment complex or confusing code; superfluous comments (restating
  what the code plainly does) are not welcome.
- Keep new comments to one or two lines. Say the non-obvious thing — why, or
  the catch — and let the code say the rest.
- Imports stay acyclic: `src/utils.ts` may import from `src/nodes/` (e.g. `Die`),
  so helpers it depends on must not be moved onto a node class that imports
  back from `src/utils.ts`.

## Dependencies

- Pin **exact** versions in `package.json` — no `^`, `~`, or other ranges.
  Use `bun add --exact` (or `bun add -E`) so new dependencies are pinned too.

## Self-maintenance

When user feedback implies a new standing rule (a correction, preference, or
workflow constraint that should apply to future work), proactively prompt the
user with a concrete one-line rule proposal for `AGENTS.md` and add it once
confirmed. Corrections stay in effect for the rest of the session even before
they are written down.
