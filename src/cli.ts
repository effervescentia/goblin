#!/usr/bin/env bun
/**
 * Goblin CLI — resolves the application state and prints it as JSON.
 *
 * Usage:
 *   goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--invoke fn(args)] [--in state.json|-] [--out file.json] [--help]
 *
 * With no entry file, `.goblin.yaml` in the current directory is required.
 * An entry containing a directory (`examples/foo.yaml`) is resolved with
 * that directory as the root, so `$tmpl('…')` paths are relative to it.
 * Resolved state goes to stdout (always valid JSON); errors go to stderr
 * with a non-zero exit code.
 */
import { createHash } from 'node:crypto';
import { type EngineEvent, GoblinEngine } from './engine';
import type { InputEvent, RollEvent, StateEvent, WriteEvent } from './inputs';
import { print } from './nodes/serialize';

export const USAGE = `goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--invoke fn(args)] [--strip-metadata] [--in state.json|-] [--out file.json] [--help]

Resolves a goblin document and prints the result as JSON: either
{ "hash", "version", "events", "data" } when all :param values are
satisfied (version counts runs since the first, bumped by each --in; events
is the stream of every --param/--set/--invoke given so far, in order, each
as { version, type: "parameter" | "override" | "invoke", path, value }, with the
engine's writes woven in as { version, type: "set" | "add" | "subtract",
path, value, rolled, source, line, column } and every die rolled as
{ version, type: "roll", path, sides, value } — in the order made, an
invoke's right after it; hash is a sha256 over the compact JSON of the rest,
plus "result" under --invoke), or
{ "query": […] } listing the outstanding parameters. A resolved sheet must
also pass its !validate rules; failing rules print as { "errors": […] }.

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
                --in replays its writes (a later --set still wins).
  --strip-metadata  Drop metadata keys (:doc, :type, !validate, …) from the
                printed data, leaving plain values only. Functions print as
                their source expression; records left empty collapse to null.
  --in          Rehydrate from a prior { "data": … } output (a file, or
                - for stdin): all its events replay. Inputs apply in order
                (later wins) and make the writes again; every recorded roll
                lands as it did, and an invoke's writes keep their values. This
                run's --param/--set/--invoke are appended as events of the
                incremented version. A hash must match the rest of the state.
  --out         Also write the JSON to this file (replacing it) when the
                document fully resolves to { "data": … }; a { "query" } or
                { "errors" } result leaves the file untouched.
  --help, -h    Show this help.`;

export interface CliArgs {
  entry?: string;
  compact: boolean;
  stripMetadata: boolean;
  help: boolean;
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

/** Pure argv parsing (excludes node/bun binary and script name). */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { compact: false, stripMetadata: false, help: false, events: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--compact') {
      args.compact = true;
    } else if (arg === '--strip-metadata') {
      args.stripMetadata = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
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
    } else if (arg === '--invoke') {
      if (args.events.some((event) => event.type === 'invoke')) throw new Error('--invoke may be given once per run');
      const [path, value] = parseInvoke(argv[++i]);
      args.events.push({ type: 'invoke', path, value });
    } else if (!arg.startsWith('-') && args.entry === undefined) {
      args.entry = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return args;
}

/** Stamp a `{ data }` (or `{ result, data }`) envelope with its version, the
 * input events that produced it and a sha256 over the rest, so a saved state
 * can be replayed and checked for edits. */
export function withHash<T>(
  state: T,
  events: StateEvent[] = [],
  version = 1,
): T | { hash: string; version: number; events: StateEvent[]; result?: unknown } {
  if (state === null || typeof state !== 'object' || !('data' in state)) return state;
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
  return (
    isRecord(event) &&
    isVersion(event.version) &&
    event.type === 'roll' &&
    typeof event.path === 'string' &&
    Number.isInteger(event.sides) &&
    (event.sides as number) > 0 &&
    Number.isInteger(event.value) &&
    (event.value as number) >= 1 &&
    (event.value as number) <= (event.sides as number)
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
 * output; re-resolving the entry recomputes the rest. A missing version reads as 0. */
export function rehydrate(state: unknown): { version: number; events: StateEvent[] } {
  if (!isRecord(state) || !('data' in state)) throw new Error('--in expects a resolved { "data": … } envelope');
  const { hash, version, events = [], result, data } = state;
  if (version !== undefined && !isVersion(version)) throw new Error('--in version must be a non-negative integer');
  if (!Array.isArray(events) || !events.every((event) => isInput(event) || isWrite(event) || isRoll(event)))
    throw new Error(
      '--in events must be { version, type, path, value } objects of type parameter, override, invoke, set, add, subtract or roll (with sides)',
    );
  // Stringify drops an undefined version or result, so states without them still verify.
  if (hash !== undefined && hash !== hashOf({ version, events, result, data }))
    throw new Error('--in state hash does not match its contents');
  return { version: version ?? 0, events };
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

// Entry point only — no-op when imported (e.g. by tests).
if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    const prior =
      args.in === undefined
        ? { version: 0, events: [] }
        : rehydrate(JSON.parse(args.in === '-' ? await Bun.stdin.text() : await Bun.file(args.in).text()));
    const version = prior.version + 1;
    const events: StateEvent[] = [...prior.events, ...args.events.map((event) => ({ version, ...event }))];
    const { state, actor, engine } = await resolveApp(process.cwd(), args.entry, events);
    // Only this run's invoke answers with a result; earlier ones just replay their writes.
    const invoked = args.events.some((event) => event.type === 'invoke');
    const show = args.stripMetadata ? print : (value: unknown) => value;
    const shown =
      'data' in state
        ? { ...(invoked && 'result' in state ? { result: show(state.result) } : {}), data: show(state.data) }
        : state;
    const made = 'data' in state ? engine.events(actor, state.data) : [];
    const stream = weave(
      events.filter(isInput),
      made.map((entry) => ({ ...entry, event: { ...entry.event, value: show(entry.event.value) } }) as EngineEvent),
      version,
    );
    const out = withHash(shown, stream, version);
    const json = `${JSON.stringify(out, null, args.compact ? 0 : 2)}\n`;
    // Only a full resolution is worth saving; Bun.write replaces the file.
    if (args.out !== undefined && 'data' in state) await Bun.write(args.out, json);
    process.stdout.write(json);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
