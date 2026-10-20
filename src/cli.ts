#!/usr/bin/env bun
/**
 * Goblin CLI — resolves the application state and prints it as JSON.
 *
 * Usage:
 *   goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--invoke fn(args)] [--in state.json|-] [--out file.json] [--server] [--help]
 *
 * With no entry file, `.goblin.yaml` in the current directory is required.
 * An entry containing a directory (`examples/foo.yaml`) is resolved with
 * that directory as the root, so `$tmpl('…')` paths are relative to it.
 * Resolved state goes to stdout (always valid JSON); errors go to stderr
 * with a non-zero exit code.
 */
import { createHash } from 'node:crypto';
import { GoblinEngine } from './engine';
import { type InputEvent, parseDice, type RollEvent, type StateEvent, type WriteEvent } from './inputs';
import type { EngineEvent } from './journal';
import { print } from './nodes/serialize';
import { INVALID_PARAMS, StdioError, serve } from './server/stdio';

export const USAGE = `goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--invoke fn(args)] [--strip-metadata] [--in state.json|-] [--out file.json] [--server] [--help]

Resolves a goblin document and prints the result as JSON: either
{ "hash", "version", "events", "data" } when all :param values are
satisfied (version counts runs since the first, bumped by each --in; events
is the stream of every --param/--set/--invoke given so far, in order, each
as { version, type: "parameter" | "override" | "invoke", path, value }, with the
engine's writes woven in as { version, type: "set" | "add" | "subtract",
path, value, rolled, source, line, column } and every roll as
{ version, type: "roll", path, dice: "XdY", value: [faces] } — in the order
made, an invoke's right after it; hash is a sha256 over the compact JSON of
the rest, plus "result" under --invoke), or
{ "hash", "version", "events", "query": […] } listing the outstanding
parameters. A resolved sheet must also pass its !validate rules; failing
rules print as { "errors": […] }.

Arguments:
  entry.yaml    Entry document (default: main from .goblin.yaml).
                If it contains a directory, $tmpl('…') resolves relative to it.
  --compact     Single-line JSON output (default: pretty-printed).
  --param       Provide a :param value (repeatable). Values parse as JSON,
                falling back to strings: --param level=3 --param name=Aria
  --set         Override any value by path (repeatable, applied after
                patches): --set level=5. Overridden originals are ignored,
                even missing paths; :param records keep their :type contract.
  --invoke      Call a function on the resolved document (once per run), by
                path with JSON arguments: --invoke rest.short or
                --invoke 'heal(5)'. Its writes land in "data" and its return
                value prints as "result"; the call is saved as an event, so
                --in replays its writes (a later --set still wins). It needs a
                stable state: no --param or --set in the same run, and an
                --in state (or, without one, the entry) that resolves to
                "data". An invoke that brings in new params answers
                { "query" }; save it and answer with --param.
  --strip-metadata  Drop metadata keys (:doc, :type, !validate, …) from the
                printed data, leaving plain values only. Functions print as
                their source expression; records left empty collapse to null.
  --in          Rehydrate from a prior { "data": … } or { "query": … }
                output (a file, or - for stdin): all its events replay. Inputs apply in order
                (later wins) and make the writes again; every recorded roll
                lands as it did, and an invoke's writes keep their values. This
                run's --param/--set/--invoke are appended as events of the
                incremented version. A hash must match the rest of the state.
  --out         Also write the JSON to this file (replacing it) when the
                document resolves to { "data": … } or asks with
                { "query": … }; an { "errors" } result leaves it untouched.
  --server      Stay up as a server: read JSON-RPC 2.0 requests from stdin
                and write responses to stdout, each message one CBOR item.
                Method "resolve" takes { entry?, in?, inputs?, stripMetadata? }
                — in is a prior envelope, inputs a list of { type:
                "parameter" | "override" | "invoke", path, value } — and
                answers the envelope a run would print. Exits at end of stdin.
                Cannot be combined with --param, --set, --invoke, --out,
                --strip-metadata or --compact.
  --help, -h    Show this help.`;

export interface CliArgs {
  entry?: string;
  compact: boolean;
  stripMetadata: boolean;
  help: boolean;
  /** Serve CBOR-encoded JSON-RPC over stdio instead of resolving once. */
  server: boolean;
  in?: string;
  out?: string;
  /** Every --param / --set / --invoke in the order given; the run stamps their version. */
  events: Omit<InputEvent, 'version'>[];
}

/** Parse a --param/--set value as JSON, falling back to a plain string. */
export function parseParamValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Split a `key=value` pair for --param/--set. */
function parseKeyValue(flag: string, pair: string | undefined): [string, unknown] {
  const eq = pair?.indexOf('=') ?? -1;
  if (pair === undefined || eq <= 0) throw new Error(`${flag} expects key=value, got: ${pair ?? '(nothing)'}`);
  return [pair.slice(0, eq), parseParamValue(pair.slice(eq + 1))];
}

/** Split an --invoke target `path` / `path(args)`, its arguments a JSON list body. */
function parseInvoke(target: string | undefined): [string, unknown[]] {
  const match = target?.match(/^([^()\s=]+)(?:\((.*)\))?$/s);
  if (target === undefined || !match) throw new Error(`--invoke expects fn or fn(args), got: ${target ?? '(nothing)'}`);
  const [, path = '', inner = ''] = match;
  try {
    return [path, JSON.parse(`[${inner}]`) as unknown[]];
  } catch {
    throw new Error(`--invoke arguments must be JSON values, got: ${inner}`);
  }
}

const INVOKE_ALONE =
  '--invoke cannot be combined with --param or --set: invoke on a stable state, answer in another run';

/** Flags that shape a single run's inputs or output, meaningless to a server answering many. */
const ONE_SHOT = ['--param', '--set', '--invoke', '--out', '--strip-metadata', '--compact'];

/** Pure argv parsing (excludes node/bun binary and script name). */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { compact: false, stripMetadata: false, help: false, server: false, events: [] };
  const oneShot: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (ONE_SHOT.includes(arg)) oneShot.push(arg);
    if (arg === '--compact') {
      args.compact = true;
    } else if (arg === '--strip-metadata') {
      args.stripMetadata = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--server') {
      args.server = true;
    } else if (arg === '--out') {
      const path = argv[++i];
      if (path === undefined || path.startsWith('-'))
        throw new Error(`--out expects a file path, got: ${path ?? '(nothing)'}`);
      args.out = path;
    } else if (arg === '--in') {
      const path = argv[++i];
      if (path === undefined || (path.startsWith('-') && path !== '-'))
        throw new Error(`--in expects a file path or -, got: ${path ?? '(nothing)'}`);
      args.in = path;
    } else if (arg === '--param' || arg === '--set') {
      const [path, value] = parseKeyValue(arg, argv[++i]);
      args.events.push({ type: arg === '--param' ? 'parameter' : 'override', path, value });
      if (args.events.some((event) => event.type === 'invoke')) throw new Error(INVOKE_ALONE);
    } else if (arg === '--invoke') {
      if (args.events.some((event) => event.type === 'invoke')) throw new Error('--invoke may be given once per run');
      if (args.events.length > 0) throw new Error(INVOKE_ALONE);
      const [path, value] = parseInvoke(argv[++i]);
      args.events.push({ type: 'invoke', path, value });
    } else if (!arg.startsWith('-') && args.entry === undefined) {
      args.entry = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (args.server && oneShot.length > 0) throw new Error(`--server cannot be combined with ${oneShot[0]}`);
  return args;
}

/** Stamp a `{ data }` (or `{ result, data }`) or `{ query }` envelope with its
 * version, the input events that produced it and a sha256 over the rest, so a
 * saved state can be replayed and checked for edits. */
export function withHash<T>(
  state: T,
  events: StateEvent[] = [],
  version = 1,
): T | { hash: string; version: number; events: StateEvent[]; result?: unknown } {
  if (state === null || typeof state !== 'object') return state;
  if ('query' in state) {
    const body = { version, events, query: state.query };
    return { hash: hashOf(body), ...body };
  }
  if (!('data' in state)) return state;
  const body = { version, events, ...('result' in state ? { result: state.result } : {}), data: state.data };
  return { hash: hashOf(body), ...body };
}

function hashOf(body: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isVersion = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

function isInput(event: unknown): event is InputEvent {
  return (
    isRecord(event) &&
    isVersion(event.version) &&
    (event.type === 'parameter' ||
      event.type === 'override' ||
      (event.type === 'invoke' && Array.isArray(event.value))) &&
    typeof event.path === 'string' &&
    event.path !== '' &&
    'value' in event
  );
}

function isWrite(event: unknown): event is WriteEvent {
  return (
    isRecord(event) &&
    isVersion(event.version) &&
    (event.type === 'set' || event.type === 'add' || event.type === 'subtract') &&
    typeof event.path === 'string' &&
    'value' in event &&
    (event.rolled === undefined || typeof event.rolled === 'boolean')
  );
}

function isRoll(event: unknown): event is RollEvent {
  if (!isRecord(event) || !isVersion(event.version) || event.type !== 'roll' || typeof event.path !== 'string')
    return false;
  const [count, sides] = (typeof event.dice === 'string' && parseDice(event.dice)) || [];
  const faces = event.value;
  return (
    sides !== undefined &&
    Array.isArray(faces) &&
    faces.length === count &&
    faces.every((face) => Number.isInteger(face) && face >= 1 && face <= sides)
  );
}

/** Thread the engine's writes and rolls into the input stream in the order
 * made: those from resolving ahead of the first invoke (or last, with none),
 * each invoke's after it. One keeps the version a replayed stream recorded
 * for it, else takes its invoke's, else this run's `version`. */
export function weave(inputs: InputEvent[], writes: EngineEvent[], version: number): StateEvent[] {
  const first = inputs.find((input) => input.type === 'invoke');
  const after = (phase: InputEvent | undefined) =>
    writes
      .filter((write) => write.phase === phase)
      .map(({ cause, version: kept, event }) => ({ version: kept ?? cause?.version ?? version, ...event }));
  return [
    ...inputs.flatMap((input) => [
      ...(input === first ? after(undefined) : []),
      input,
      ...(input.type === 'invoke' ? after(input) : []),
    ]),
    ...(first === undefined ? after(undefined) : []),
  ];
}

/** The `version` and `events` of a prior `{ hash, version, events, data }`
 * output, or of a `{ … query }` one still asking (not `stable`); re-resolving
 * the entry recomputes the rest. A missing version reads as 0. */
export function rehydrate(state: unknown): { version: number; events: StateEvent[]; stable: boolean } {
  if (!isRecord(state) || !('data' in state || 'query' in state))
    throw new Error('--in expects a { "data": … } or { "query": … } envelope');
  const { hash, version, events = [], result, data, query } = state;
  const stable = 'data' in state;
  if (version !== undefined && !isVersion(version)) throw new Error('--in version must be a non-negative integer');
  if (!Array.isArray(events) || !events.every((event) => isInput(event) || isWrite(event) || isRoll(event)))
    throw new Error(
      '--in events must be { version, type, path, value } objects of type parameter, override, invoke, set, add, subtract or roll (with dice)',
    );
  // Stringify drops an undefined version or result, so states without them still verify.
  const body = stable ? { version, events, result, data } : { version, events, query };
  if (hash !== undefined && hash !== hashOf(body)) throw new Error('--in state hash does not match its contents');
  return { version: version ?? 0, events, stable };
}

/** Resolution envelope plus `{ errors }` for sheets failing `!validate`. */
export type AppState = ReturnType<GoblinEngine['resolve']> | { errors: string[] };

export async function resolveAppState(cwd: string, entry?: string, inputs: StateEvent[] = []): Promise<AppState> {
  return (await resolveApp(cwd, entry, inputs)).state;
}

/** `resolveAppState`, plus the merged raw actor it resolved — what the
 * inspector reads expressions and dependencies from. */
export async function resolveApp(
  cwd: string,
  entry?: string,
  inputs: StateEvent[] = [],
): Promise<{ state: AppState; actor: unknown; engine: GoblinEngine }> {
  // Bun-only: the CLI entry point always runs under Bun (or compiled).
  const { YAML } = await import('bun');
  let root = cwd;
  let main = entry;
  if (main === undefined) {
    const config = Bun.file(`${cwd}/.goblin.yaml`);
    if (await config.exists()) {
      const opts = YAML.parse(await config.text()) as { root: string; main: string };
      root = `${cwd}/${opts.root}`;
      main = opts.main;
    } else {
      throw new Error(`no entry provided and .goblin.yaml was not found in ${cwd}`);
    }
  }
  if (entry !== undefined && main.includes('/')) {
    // Resolve relative to the entry's own directory so `$tmpl('…')`
    // references stay local to it.
    const slash = main.lastIndexOf('/');
    root = main.startsWith('/') ? main.slice(0, slash) : `${cwd}/${main.slice(0, slash)}`;
    main = main.slice(slash + 1);
  }
  const engine = new GoblinEngine(root);
  await engine.loadFile(main);
  // The entry's whole root is the answer; actors nest in it as `$actor` documents.
  const actor = engine.docs.get(main);
  const state = engine.resolveRaw(actor, inputs);
  // A resolved sheet must also hold: `!validate` rules are part of the answer,
  // not a separate pass the caller might skip.
  if ('data' in state) {
    const errors = engine.validate(state.data);
    if (errors.length > 0) return { state: { errors }, actor, engine };
  }
  return { state, actor, engine };
}

/** One resolution turn: replay a prior envelope (`--in`), append these inputs
 * as its next version, and answer with the envelope the CLI prints. */
export async function run(
  cwd: string,
  { entry, prior: saved, inputs, stripMetadata = false }: RunRequest,
): Promise<unknown> {
  const prior = saved === undefined ? { version: 0, events: [], stable: true } : rehydrate(saved);
  // An invoke acts on a settled sheet: a saved one, or an entry that needs no input.
  const invoked = inputs.some((event) => event.type === 'invoke');
  if (invoked && inputs.length > 1) throw new Error(INVOKE_ALONE);
  if (invoked && !prior.stable) throw new Error('--invoke needs a stable state: --in still asks for params');
  if (invoked && saved === undefined && !('data' in (await resolveAppState(cwd, entry))))
    throw new Error('--invoke needs a stable state: the entry asks for params or fails validation');
  const version = prior.version + 1;
  const events: StateEvent[] = [...prior.events, ...inputs.map((event) => ({ version, ...event }))];
  const { state, actor, engine } = await resolveApp(cwd, entry, events);
  // Only this run's invoke answers with a result; earlier ones just replay their writes.
  const show = stripMetadata ? print : (value: unknown) => value;
  const shown =
    'data' in state
      ? { ...(invoked && 'result' in state ? { result: show(state.result) } : {}), data: show(state.data) }
      : state;
  const made = 'errors' in state ? [] : engine.events(actor, 'data' in state ? state.data : undefined);
  const stream = weave(
    events.filter(isInput),
    made.map((entry) => ({ ...entry, event: { ...entry.event, value: show(entry.event.value) } }) as EngineEvent),
    version,
  );
  return withHash(shown, stream, version);
}

export interface RunRequest {
  entry?: string;
  /** A prior `{ data }` / `{ query }` envelope to replay, as `--in` reads it. */
  prior?: unknown;
  inputs: Omit<InputEvent, 'version'>[];
  stripMetadata?: boolean;
}

const RESOLVE_PARAMS = 'resolve expects { entry?, in?, inputs?: [{ type, path, value }], stripMetadata? }';

/** Check `--server` `resolve` params, holding inputs to the rules `parseArgs` does. */
export function parseRunParams(params: unknown = {}): RunRequest {
  if (!isRecord(params)) throw new StdioError(INVALID_PARAMS, RESOLVE_PARAMS);
  const { entry, in: prior, inputs = [], stripMetadata = false } = params;
  if (
    (entry !== undefined && typeof entry !== 'string') ||
    typeof stripMetadata !== 'boolean' ||
    !Array.isArray(inputs) ||
    !inputs.every((input) => isInput({ version: 0, ...input }))
  )
    throw new StdioError(INVALID_PARAMS, RESOLVE_PARAMS);
  const invokes = inputs.filter((input) => input.type === 'invoke').length;
  if (invokes > 1) throw new StdioError(INVALID_PARAMS, 'inputs may hold one invoke per call');
  if (invokes > 0 && inputs.length > 1) throw new StdioError(INVALID_PARAMS, INVOKE_ALONE);
  return { entry, prior, inputs: inputs as RunRequest['inputs'], stripMetadata };
}

// Entry point only — no-op when imported (e.g. by tests).
if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (args.server) {
      const cwd = process.cwd();
      await serve(process.stdin, (bytes) => process.stdout.write(bytes), {
        resolve: (params) => run(cwd, parseRunParams(params)),
      });
      process.exit(0);
    }
    const prior =
      args.in === undefined
        ? undefined
        : JSON.parse(args.in === '-' ? await Bun.stdin.text() : await Bun.file(args.in).text());
    const out = await run(process.cwd(), {
      entry: args.entry,
      prior,
      inputs: args.events,
      stripMetadata: args.stripMetadata,
    });
    const json = `${JSON.stringify(out, null, args.compact ? 0 : 2)}\n`;
    // A state that resolves or asks can be saved; Bun.write replaces the file.
    if (args.out !== undefined && !(out !== null && typeof out === 'object' && 'errors' in out))
      await Bun.write(args.out, json);
    process.stdout.write(json);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
