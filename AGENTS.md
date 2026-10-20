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
   do not add new ones if avoidable. Use `bun run format` to auto-fix formatting, import order and safe lint fixes.

2. **Tests** — [Vitest](https://vitest.dev):
   ```sh
   bun run test
   ```
   Unit tests sit beside their source (`src/**/*.test.ts`); end-to-end suites live in `test/`. All tests must pass. Add or update tests when
   changing engine behavior in `src/core/engine.ts`.

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
- Every example must stay runnable: `test/examples.test.ts` resolves each file
  through the real CLI and fails on non-zero exit or invalid JSON.
- When syntax changes, update `SYNTAX.md`, `src/core/engine.ts`, `examples/`, and
  the tests together — a feature without a working example is incomplete.

## Project notes

- `src/main.ts` exports `GoblinEngine`. The CLI uses `.goblin.yaml` from the
  current directory when no entry is provided.
  The final evaluated state always logs; diagnostics need `--debug`
  (validation failures always log as errors).
- `bun run build` compiles `src/cli/cli.ts` to a `build/goblin` binary
  (`goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--invoke fn(args)] [--in state.json|-] [--out file.json] [--server stdio|http] [--port n] [--help]`) that prints
  the resolution envelope (`{ hash, version, events, result?, data }` — a run counter, the append-only stream of every `--param`/`--set`/`--invoke` given (as `parameter`/`override`/`invoke` events) with the engine's `set`/`add`/`subtract` writes and every die `roll` woven in (`weave`, in the order made), and the return value of this run's `--invoke`, with `hash` a `sha256:` of the compact JSON of the rest — `{ hash, version, events, query }` when params are outstanding, or `{ errors }` for failing `!validate` rules) as JSON to stdout, also writing it to `--out` unless it is `{ errors }`. `--invoke` only runs on a stable state: never alongside `--param`/`--set`, and only on an `--in` state (or bare entry) that resolves to `{ data }`. `--in` replays all of a prior output's `events` — inputs re-make the writes, recorded rolls replay as a tape (`Die.within` frames), and invoke-made writes keep their values — appends this run's, and bumps its `version` (`-` reads stdin). Keep serialized key order deterministic (same input → same order) — the
  `hash` is over `JSON.stringify`, so unstable ordering silently changes it. `src/cli/cli.ts` is Bun-only; keep `parseArgs` pure
  so `src/cli/cli.test.ts` stays runtime-agnostic.
- `--server stdio|http` keeps the CLI up as a JSON-RPC 2.0 server. Dispatch lives in
  `src/server/rpc.ts`; the transports only frame it — `stdio` one CBOR item per message
  (`src/server/stdio.ts`), `http` one JSON body per `POST /` on 127.0.0.1, `--port`
  (`src/server/http.ts`, a web-standard `fetch` handler so tests need no Bun). Its `resolve`
  method calls the same `run` as a one-shot invocation, so its result is the exact envelope
  (and `hash`) the CLI prints; add methods to `serverMethods` in `src/cli/cli.ts`, not a transport.
- `bun run ui` serves the inspector (`ui/`, Bun-only) at localhost:3000: it
  resolves an entry via `resolveApp` in `src/cli/cli.ts`, answers `{ query }`
  turns with a form, and renders `inspect()` (`src/inspect.ts`, pure) —
  fields, what each reads and is read by, and their `:events`.
- Engine inputs are the same `InputEvent` stream the CLI saves (`src/inputs.ts`):
  `resolve`/`evaluateDoc`/`apply` take `InputEvent[]`, never param/override
  records. Replay semantics (latest per path wins) live in `src/inputs.ts`.
- `src/core/engine.ts` transpiles goblin expressions with `new Function` — every
  `.name` token is treated as a goblin ref, so avoid introducing bare JS
  property access in expression strings.
- Keep test fixtures in `src/core/engine.test.ts` runtime-agnostic by seeding
  `engine.docs` directly instead of using `loadFile`.

## Code layout

- Node-specific utilities belong in `src/nodes/`, attached as static functions
  or methods on the node class they serve (e.g. `FunctionNode.match`,
  `DieNode.parse`, `RecordNode.collectParams`, each node's `serialize`) — not as
  loose helpers in `src/utils.ts`. Keep `src/utils.ts` for genuinely shared,
  node-agnostic code (refs, paths, expression compilation, serialization).
- `GoblinEngine` (`src/core/engine.ts`) keeps resolution, evaluation and inputs;
  it delegates to `src/core/patcher.ts` (applying patches and mixins, call
  expansion), `src/core/journal.ts` (per-field `:events`, the write/roll stream,
  the roll tape), `src/core/provenance.ts` (WeakMap side tables: origins, owners,
  homes, namespaces, locations) and `src/core/registry.ts` (loading, `$tmpl`
  discovery, `$`/`$lib` binding). New history state goes in
  the journal and new "where did this come from" state in provenance, not on the engine.
- The standard library (`$lib`) lives in `src/lib/`: one file per namespace
  (`math.ts`), listed in `src/lib/index.ts`, plus `src/lib/lib.yaml` for
  yaml-defined helpers. Natives always win over yaml of the same name.
- Only comment complex or confusing code; superfluous comments (restating
  what the code plainly does) are not welcome.
- Keep new comments to one or two lines. Say the non-obvious thing — why, or
  the catch — and let the code say the rest.
- Use `ts-pattern`'s `match` instead of nested ternary expressions.
- Import across directories with `@/…` (e.g. `@/core/engine`), or `@test/…`
  for `test/`; use relative paths (`./x`) only within the same directory.
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
