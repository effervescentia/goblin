#!/usr/bin/env bun
/**
 * Goblin CLI — resolves the application state and prints it as JSON.
 *
 * Usage:
 *   goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--in state.json|-] [--out file.json] [--help]
 *
 * With no entry file, `.goblin.yaml` in the current directory is required.
 * An entry containing a directory (`examples/foo.yaml`) is resolved with
 * that directory as the root, so `$tmpl('…')` paths are relative to it.
 * Resolved state goes to stdout (always valid JSON); errors go to stderr
 * with a non-zero exit code.
 */
import { createHash } from 'node:crypto';
import { GoblinEngine } from './engine';
import { print } from './nodes/serialize';

export const USAGE = `goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--strip-metadata] [--in state.json|-] [--out file.json] [--help]

Resolves a goblin document and prints the result as JSON: either
{ "hash", "version", "events", "data" } when all :param values are
satisfied (version counts runs since the first, bumped by each --in; events
is the stream of every --param/--set given so far, each as
{ version, type: "param" | "set", path, value }; hash is a sha256 over the
compact JSON of the rest), or
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
  --strip-metadata  Drop metadata keys (:doc, :type, !validate, …) from the
                printed data, leaving plain values only. Functions print as
                their source expression; records left empty collapse to null.
  --in          Rehydrate from a prior { "data": … } output (a file, or
                - for stdin): its events are replayed in order (later wins),
                this run's --param/--set are appended as events of the
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
  params: Record<string, unknown>;
  overrides: Record<string, unknown>;
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

/** Pure argv parsing (excludes node/bun binary and script name). */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { compact: false, stripMetadata: false, help: false, params: {}, overrides: {} };
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
      const [key, value] = parseKeyValue(arg, argv[++i]);
      if (arg === '--param') args.params[key] = value;
      else args.overrides[key] = value;
    } else if (!arg.startsWith('-') && args.entry === undefined) {
      args.entry = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return args;
}

export interface Inputs {
  parameters: Record<string, unknown>;
  overrides: Record<string, unknown>;
}

/** One `--param` or `--set` given on the run that produced `version`. */
export interface InputEvent {
  version: number;
  type: 'param' | 'set';
  path: string;
  value: unknown;
}

/** This run's flags as events: params, then sets, each in the order given. */
export function toEvents(inputs: Inputs, version: number): InputEvent[] {
  return [
    ...Object.entries(inputs.parameters).map(([path, value]) => ({ version, type: 'param' as const, path, value })),
    ...Object.entries(inputs.overrides).map(([path, value]) => ({ version, type: 'set' as const, path, value })),
  ];
}

/** Replay an event stream into the inputs it amounts to; later events win. */
export function fold(events: InputEvent[]): Inputs {
  const inputs: Inputs = { parameters: {}, overrides: {} };
  for (const { type, path, value } of events) {
    if (type === 'param') inputs.parameters[path] = value;
    else inputs.overrides[path] = value;
  }
  return inputs;
}

/** Stamp a `{ data }` envelope with its version, the input events that produced it
 * and a sha256 over the rest, so a saved state can be replayed and checked for edits. */
export function withHash<T>(
  state: T,
  events: InputEvent[] = [],
  version = 1,
): T | { hash: string; version: number; events: InputEvent[] } {
  if (state === null || typeof state !== 'object' || !('data' in state)) return state;
  const body = { version, events, data: state.data };
  return { hash: hashOf(body), ...body };
}

function hashOf(body: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isVersion = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

function isEvent(event: unknown): event is InputEvent {
  return (
    isRecord(event) &&
    isVersion(event.version) &&
    (event.type === 'param' || event.type === 'set') &&
    typeof event.path === 'string' &&
    event.path !== '' &&
    'value' in event
  );
}

/** The `version` and `events` of a prior `{ hash, version, events, data }` output;
 * re-resolving the entry recomputes the rest. A missing version reads as 0. */
export function rehydrate(state: unknown): { version: number; events: InputEvent[] } {
  if (!isRecord(state) || !('data' in state)) throw new Error('--in expects a resolved { "data": … } envelope');
  const { hash, version, events = [], data } = state;
  if (version !== undefined && !isVersion(version)) throw new Error('--in version must be a non-negative integer');
  if (!Array.isArray(events) || !events.every(isEvent))
    throw new Error('--in events must be { version, type: "param" | "set", path, value } objects');
  // Stringify drops an undefined version, so states predating it still verify.
  if (hash !== undefined && hash !== hashOf({ version, events, data }))
    throw new Error('--in state hash does not match its contents');
  return { version: version ?? 0, events };
}

/** Resolution envelope plus `{ errors }` for sheets failing `!validate`. */
export type AppState = ReturnType<GoblinEngine['resolve']> | { errors: string[] };

export async function resolveAppState(
  cwd: string,
  entry?: string,
  provided: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): Promise<AppState> {
  return (await resolveApp(cwd, entry, provided, overrides)).state;
}

/** `resolveAppState`, plus the merged raw actor it resolved — what the
 * inspector reads expressions and dependencies from. */
export async function resolveApp(
  cwd: string,
  entry?: string,
  provided: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
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
  const state = engine.resolveRaw(actor, provided, overrides);
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
    const events = [...prior.events, ...toEvents({ parameters: args.params, overrides: args.overrides }, version)];
    const inputs = fold(events);
    const state = await resolveAppState(process.cwd(), args.entry, inputs.parameters, inputs.overrides);
    const out = withHash(args.stripMetadata && 'data' in state ? { data: print(state.data) } : state, events, version);
    const json = `${JSON.stringify(out, null, args.compact ? 0 : 2)}\n`;
    // Only a full resolution is worth saving; Bun.write replaces the file.
    if (args.out !== undefined && 'data' in state) await Bun.write(args.out, json);
    process.stdout.write(json);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
