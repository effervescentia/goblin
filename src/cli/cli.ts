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
import z from 'zod';
import { GoblinEngine } from '@/core/engine';
import type { EngineEvent } from '@/core/journal';
import { StateEventSchema, VersionSchema } from '@/dtos';
import { type InputEvent, isInputEvent, type StateEvent } from '@/inputs';
import { print } from '@/nodes/serialize';
import { INVALID_PARAMS, StdioError, StdioServer } from '@/server/stdio';
import { INVOKE_ALONE, ONE_SHOT, USAGE } from './constants';
import { ConfigSchema, ResolveParamsSchema } from './dtos';

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

/** Pure argv parsing (excludes node/bun binary and script name). */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { compact: false, stripMetadata: false, help: false, server: false, events: [] };
  const oneShot: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (ONE_SHOT.has(arg)) oneShot.push(arg);
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
  if (version !== undefined && !VersionSchema.safeParse(version).success)
    throw new Error('--in version must be a non-negative integer');
  // Validate only: the raw events keep their key order, which the hash below covers.
  if (!z.array(StateEventSchema).safeParse(events).success)
    throw new Error(
      '--in events must be { version, type, path, value } objects of type parameter, override, invoke, set, add, subtract or roll (with dice)',
    );
  // Stringify drops an undefined version or result, so states without them still verify.
  const body = stable ? { version, events, result, data } : { version, events, query };
  if (hash !== undefined && hash !== hashOf(body)) throw new Error('--in state hash does not match its contents');
  return { version: (version as number | undefined) ?? 0, events: events as StateEvent[], stable };
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
      const parsed = ConfigSchema.safeParse(YAML.parse(await config.text()));
      if (!parsed.success) throw new Error(`invalid .goblin.yaml: ${z.prettifyError(parsed.error)}`);
      const opts = parsed.data;
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
    events.filter(isInputEvent),
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

/** Check `--server` `resolve` params. */
export function parseRunParams(params: unknown = {}): RunRequest {
  const parsed = ResolveParamsSchema.safeParse(params);
  if (!parsed.success) throw new StdioError(INVALID_PARAMS, `${RESOLVE_PARAMS}\n${z.prettifyError(parsed.error)}`);
  const { entry, in: prior, inputs, stripMetadata } = parsed.data;
  return { entry, prior, inputs, stripMetadata };
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
      const server = new StdioServer({ resolve: (params) => run(cwd, parseRunParams(params)) });
      await server.serve(process.stdin, (bytes) => process.stdout.write(bytes));
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
