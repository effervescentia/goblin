# AGENTS.md

Instructions for AI coding agents working in this repository.

## Runtime

This project uses **Bun** (not Node) as the runtime and package manager.
Use `bun <file>` to run scripts and `bun add` / `bun install` for dependencies.

## Validating changes

Always validate code changes with **both** of the following before finishing:

1. **Lint + types + unused** — [Biome](https://biomejs.dev) for lint/format, `tsc` for types,
   [Knip](https://knip.dev) for unused files, exports and dependencies:
   ```sh
   bun run check
   ```
   This runs `check:format` (`biome check`), `check:types` (`tsc --noEmit`) and
   `check:unused` (`knip`). Don't export what only its own file uses; entry points live in `knip.json`.
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
  (`goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--invoke fn(args)] [--in state.json|-] [--out file.json] [--server stdio|http|websocket] [--stateless] [--session id] [--history n] [--format cbor|json] [--port n] [--help]`) that prints
  the resolution envelope (`{ hash, version, events, result?, data }` — a run counter, the append-only stream of every `--param`/`--set`/`--invoke` given (as `parameter`/`override`/`invoke` events) with the engine's `set`/`add`/`subtract` writes and every die `roll` woven in (`weave`, in the order made), and the return value of this run's `--invoke`, with `hash` a `sha256:` of the compact JSON of the rest — `{ hash, version, events, query }` when params are outstanding, or `{ errors }` for failing `!validate` rules) as JSON to stdout, also writing it to `--out` unless it is `{ errors }`. `--invoke` only runs on a stable state: never alongside `--param`/`--set`, and only on an `--in` state (or bare entry) that resolves to `{ data }`. `--in` replays all of a prior output's `events` — inputs re-make the writes, recorded rolls replay as a tape (`Die.within` frames), and invoke-made writes keep their values — appends this run's, and bumps its `version` (`-` reads stdin). Keep serialized key order deterministic (same input → same order) — the
  `hash` is over `JSON.stringify`, so unstable ordering silently changes it. `src/cli/cli.ts` is Bun-only; keep `parseArgs` pure
  so `src/cli/cli.test.ts` stays runtime-agnostic.
- `--server stdio|http|websocket` keeps the CLI up as a JSON-RPC 2.0 server. Dispatch lives in
  `src/server/rpc.server.ts`; the transports only frame it — `stdio` one message per CBOR item or JSON line
  (`src/server/stdio.server.ts`), `http` one body per `POST /` on 127.0.0.1, `--port`
  (`src/server/http.server.ts`, a web-standard `fetch` handler so tests need no Bun), `websocket` one message
  per frame after an upgrade at `/` on 127.0.0.1, `--port` (`src/server/websocket.server.ts`, Bun-shaped
  `fetch`/`websocket` handlers over minimal socket interfaces). `--format cbor|json`
  (default `cbor`, `--server` only) picks the encoding for all three — binary or text frames over websocket — via `src/server/codec.ts`. Its `resolve`
  method calls the same `run` as a one-shot invocation, so its result is the exact envelope
  (and `hash`) the CLI prints; `inspect` (`inspectState`) answers `inspect()`'s nodes for the session head
  (or a `--stateless` server's `in`), `[]` while it asks; add methods to `serverMethods` in `src/cli/cli.ts`, not a transport.
  Servers are stateful unless `--stateless`: a `Session` (`src/server/session.ts`) appends each answered
  turn (not `{ errors }`) to `~/.goblin/sessions/<sessionID>/log.cbor`, a CBOR Sequence (no delimiters) whose
  first item is a checkpoint holding every event so far and each later one `{ version, entry, at?, events, hash, query? }`
  with only that turn's new events (`at` when a reweave changed earlier ones). `manifest.json` (`{ entry, version, offsets }`)
  indexes each version's byte offset, so the `rewind` method is a truncate; `--history` (default 30) is how many
  versions can be rewound, older ones folding into a new checkpoint once the log holds twice that. Loading a log
  cuts off a torn final item. Each `resolve` continues from the head (one turn at a time; another entry starts a
  fresh log) and adds `previous` (a version)/`sessionID` beside the envelope — outside its `hash`. A stateful
  server refuses `--in` and a `resolve` with `in`. `--session <id>` reopens a saved session (`Session.resume`) instead of starting a new one. Tests that spawn a server set `HOME` to a temp dir.
- `goblin/client` (`src/client/main.ts`, a `package.json` sub-export) is the JSON-RPC
  client for `--server`: `createClient({ transport: 'stdio' | 'http' | 'websocket', format?, … })` is
  its single entrypoint, connecting to a running server (`url`, or a `stream` for stdio) or spawning
  one (`spawn: { command?, args?, cwd? }`; the client adds `--server`/`--format`/`--port 0` and reads
  the logged URL). Id matching, failure and `close` (waits out in-flight calls) live in
  `src/client/rpc.client.ts`; each transport only frames, reusing `src/server/codec.ts`. Keep it free
  of Bun APIs — `node:child_process` loads lazily, only to spawn.
- `bun run inspector` serves the inspector (`inspector/`, Bun-only) at localhost:1337: it
  resolves an entry via `resolveApp` in `src/cli/cli.ts`, answers `{ query }`
  turns with a form, and renders `inspect()` (`src/inspect.ts`, pure) —
  fields, what each reads and is read by, and their `:events`.
- `bun run demo` serves a character sheet (`demo/`, Bun-only) at localhost:1338
  for `aria` in `5e/main.yaml`: `demo/server.ts` spawns a stateful
  `--server websocket`, and the page (Preact) talks to it only through `goblin/client`,
  answering `{ query }` with form inputs, invoking rests and actions, and listing the table's `log` (attacks, fights starting, initiative), each roll's formula on hover, in a right-hand panel. Hovering a value shows
  its expression (from the `inspect` method) and its `:events`, minus an empty first slot (only once the Events checkbox in the header is ticked).
  Reading the resolved tree (`:value`, `:label`) lives in `demo/sheet.ts`, pure.
- Engine inputs are the same `InputEvent` stream the CLI saves (`src/inputs.ts`):
  `resolve`/`evaluateDoc`/`apply` take `InputEvent[]`, never param/override
  records. Replay semantics (latest per path wins) live in `src/inputs.ts`.
- `src/core/engine.ts` transpiles goblin expressions with `new Function` — every
  `.name` token is treated as a goblin ref, so avoid introducing bare JS
  property access in expression strings.
- Keep test fixtures in `src/core/engine.test.ts` runtime-agnostic by seeding
  `engine.docs` directly instead of using `loadFile`.

- Every function the demo's character sheet can invoke (actions, rests, combat
  controls, …) appends an entry to the root `log` — `$.log += [{ actor: @.name,
  action: '<key>', … }]` (no `actor` for table events) — with rolled values
  labelled (`[d20](1d20) + [STR](…)`) so the entry keeps their formula for the
  log panel's tooltip. A new one without its log entry is incomplete.

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
- Server modules in `src/server/` use a `.server.ts` suffix (`rpc.server.ts`,
  `http.server.ts`, …), and client ones in `src/client/` a `.client.ts` suffix; shared
  helpers like `codec.ts`, `spawn.ts` and `dtos.ts` don't.

## Dependencies

- Pin **exact** versions in `package.json` — no `^`, `~`, or other ranges.
  Use `bun add --exact` (or `bun add -E`) so new dependencies are pinned too.

## Self-maintenance

When user feedback implies a new standing rule (a correction, preference, or
workflow constraint that should apply to future work), proactively prompt the
user with a concrete one-line rule proposal for `AGENTS.md` and add it once
confirmed. Corrections stay in effect for the rest of the session even before
they are written down.
