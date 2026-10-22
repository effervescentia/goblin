#!/usr/bin/env bun
/**
 * Goblin CLI — resolves the application state and prints it as JSON.
 *
 * Usage:
 *   goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--invoke fn(args)] [--export actor] [--import path=export.json|-] [--in state.json|-] [--out file.json] [--server stdio|http|websocket] [--stateless] [--session id] [--history n] [--format cbor|json] [--port n] [--help]
 *
 * With no entry file, `.goblin.yaml` in the current directory is required.
 * An entry containing a directory (`examples/foo.yaml`) is resolved with
 * that directory as the root, so `$tmpl('…')` paths are relative to it.
 * Resolved state goes to stdout (always valid JSON); errors go to stderr
 * with a non-zero exit code.
 */
import { createHash } from 'node:crypto';
import { match, P } from 'ts-pattern';
import z from 'zod';
import { GoblinEngine } from '@/core/engine';
import { exportActor, locateActor } from '@/core/exporter';
import type { EngineEvent } from '@/core/journal';
import { ActorExportSchema, StateEventSchema, VersionSchema } from '@/dtos';
import { RpcError } from '@/errors';
import {
  type ActorExport,
  type ActorSet,
  type ImportValue,
  type InputEvent,
  isInputEvent,
  type StateEvent,
} from '@/inputs';
import { type InspectNode, inspect } from '@/inspect';
import { print } from '@/nodes/serialize';
import { type Format, FormatSchema } from '@/server/dtos';
import { HttpServer } from '@/server/http.server';
import { INVALID_PARAMS, type Methods } from '@/server/rpc.server';
import { Session } from '@/server/session';
import { StdioServer } from '@/server/stdio.server';
import { WebSocketServer } from '@/server/websocket.server';
import { DEFAULT_PORT, EXPORT_ALONE, IMPORT_ALONE, INVOKE_ALONE, ONE_SHOT, STATEFUL_IN, USAGE } from './constants';
import {
  ConfigSchema,
  ExportParamsSchema,
  ImportParamsSchema,
  InspectParamsSchema,
  ResolveParamsSchema,
  RewindParamsSchema,
  type ServerMode,
  ServerModeSchema,
} from './dtos';

export interface CliArgs {
  entry?: string;
  compact: boolean;
  stripMetadata: boolean;
  help: boolean;
  /** Serve JSON-RPC instead of resolving once, over stdio, HTTP or WebSocket. */
  server?: ServerMode;
  /** Answer each `--server` call on its own, keeping no session. */
  stateless: boolean;
  /** A prior `--server` session to continue, by its ID. */
  session?: string;
  /** How many versions a `--server` session can rewind to; 30 unless given. */
  history?: number;
  /** The `--server` wire format; CBOR unless given. */
  format?: Format;
  /** The `--server http|websocket` port; 0 lets the OS pick. */
  port?: number;
  in?: string;
  out?: string;
  /** Print this actor's state (a namespace or tree path) as an export instead of the envelope. */
  export?: string;
  /** Import the export in `file` (- for stdin) into the actor at `path`, as this run's only input. */
  import?: { path: string; file: string };
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
  const args: CliArgs = { compact: false, stripMetadata: false, help: false, stateless: false, events: [] };
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
      const mode = ServerModeSchema.safeParse(argv[++i]);
      if (!mode.success) throw new Error(`--server expects stdio, http or websocket, got: ${argv[i] ?? '(nothing)'}`);
      args.server = mode.data;
    } else if (arg === '--stateless') {
      args.stateless = true;
    } else if (arg === '--session') {
      const id = argv[++i];
      // Only a UUID: the ID names a directory, so it must not reach outside the sessions root.
      if (id === undefined || !z.uuid().safeParse(id).success)
        throw new Error(`--session expects a session ID (a UUID), got: ${id ?? '(nothing)'}`);
      args.session = id;
    } else if (arg === '--history') {
      const history = argv[++i];
      if (history === undefined || !/^\d+$/.test(history) || Number(history) < 1)
        throw new Error(`--history expects an integer >= 1, got: ${history ?? '(nothing)'}`);
      args.history = Number(history);
    } else if (arg === '--format') {
      const format = FormatSchema.safeParse(argv[++i]);
      if (!format.success) throw new Error(`--format expects cbor or json, got: ${argv[i] ?? '(nothing)'}`);
      args.format = format.data;
    } else if (arg === '--port') {
      const port = argv[++i];
      if (port === undefined || !/^\d+$/.test(port) || Number(port) > 65535)
        throw new Error(`--port expects a port number (0-65535), got: ${port ?? '(nothing)'}`);
      args.port = Number(port);
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
    } else if (arg === '--export') {
      const actor = argv[++i];
      if (actor === undefined || actor.startsWith('-'))
        throw new Error(`--export expects an actor (a namespace or path), got: ${actor ?? '(nothing)'}`);
      args.export = actor;
    } else if (arg === '--import') {
      if (args.import !== undefined) throw new Error('--import may be given once per run');
      const pair = argv[++i];
      const eq = pair?.indexOf('=') ?? -1;
      if (pair === undefined || eq <= 0 || eq === pair.length - 1)
        throw new Error(`--import expects path=export.json, got: ${pair ?? '(nothing)'}`);
      args.import = { path: pair.slice(0, eq), file: pair.slice(eq + 1) };
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
  if (args.import !== undefined && args.events.length > 0) throw new Error(IMPORT_ALONE);
  if (args.export !== undefined && (args.events.length > 0 || args.import !== undefined)) throw new Error(EXPORT_ALONE);
  if (args.import?.file === '-' && args.in === '-') throw new Error('--in and --import cannot both read stdin');
  if (args.server && oneShot.length > 0) throw new Error(`--server cannot be combined with ${oneShot[0]}`);
  if (args.port !== undefined && args.server !== 'http' && args.server !== 'websocket')
    throw new Error('--port needs --server http or websocket');
  if (args.format !== undefined && !args.server) throw new Error('--format needs --server');
  if (args.stateless && !args.server) throw new Error('--stateless needs --server');
  if (args.history !== undefined && (!args.server || args.stateless))
    throw new Error('--history needs a stateful --server');
  if (args.session !== undefined && (!args.server || args.stateless))
    throw new Error('--session needs a stateful --server');
  if (args.in !== undefined && args.server && !args.stateless) throw new Error(STATEFUL_IN);
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
      '--in events must be { version, type, path, value } objects of type parameter, override, invoke, import, set, add, subtract or roll (with dice)',
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
  const imports = inputs.filter((event) => event.type === 'import');
  if (imports.length > 0 && inputs.length > 1) throw new Error(IMPORT_ALONE);
  if (invoked && !prior.stable) throw new Error('--invoke needs a stable state: --in still asks for params');
  if (invoked && saved === undefined && !('data' in (await resolveAppState(cwd, entry))))
    throw new Error('--invoke needs a stable state: the entry asks for params or fails validation');
  const version = prior.version + 1;
  const events: StateEvent[] = [...prior.events, ...inputs.map((event) => ({ version, ...event }))];
  const { state, actor, engine } = await resolveApp(cwd, entry, events);
  for (const { path, value } of imports) {
    const { application } = value as ImportValue;
    if (application !== engine.application())
      throw new Error(`--import: the export is from another application (${application}), not ${engine.application()}`);
    if (locateActor(engine, actor, path) === undefined) throw new Error(`--import: no actor at ${path}`);
  }
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

/** Export `actor` (a namespace or tree path) from `prior` replayed, or from the bare entry; it must resolve to `{ data }`. */
export async function exportState(cwd: string, { entry, prior, actor }: ExportRequest): Promise<ActorExport> {
  const { events } = prior === undefined ? { events: [] } : rehydrate(prior);
  const { state, actor: root, engine } = await resolveApp(cwd, entry, events);
  if (!('data' in state)) throw new Error('--export needs a stable state: it asks for params or fails validation');
  const at = locateActor(engine, root, actor);
  if (at === undefined) throw new Error(`--export: no actor ${actor}`);
  const body = { application: engine.application(), actor, events: exportActor(engine, root, state.data, events, at) };
  return { hash: hashOf(body), ...body };
}

/** The `import` event value an `--export` output carries, once its hash checks out. */
export function readExport(payload: unknown): ImportValue {
  const parsed = ActorExportSchema.safeParse(payload);
  if (!parsed.success) throw new Error(`--import expects an --export output\n${z.prettifyError(parsed.error)}`);
  const { hash, application, actor, events } = parsed.data;
  if (hash !== undefined && hash !== hashOf({ application, actor, events }))
    throw new Error('--import export hash does not match its contents');
  return { application, events: events as ActorSet[] };
}

/** `inspect()` of `prior` (a saved envelope) replayed, or of the bare entry; none while it asks or fails validation. */
export async function inspectState(cwd: string, entry?: string, prior?: unknown): Promise<InspectNode[]> {
  const { events } = prior === undefined ? { events: [] } : rehydrate(prior);
  const { state, actor, engine } = await resolveApp(cwd, entry, events);
  return 'data' in state ? inspect(actor, state.data, engine.namespaceOf) : [];
}

export interface RunRequest {
  entry?: string;
  /** A prior `{ data }` / `{ query }` envelope to replay, as `--in` reads it. */
  prior?: unknown;
  inputs: Omit<InputEvent, 'version'>[];
  stripMetadata?: boolean;
}

export interface ExportRequest {
  entry?: string;
  prior?: unknown;
  actor: string;
}

const RESOLVE_PARAMS = 'resolve expects { entry?, in?, inputs?: [{ type, path, value }], stripMetadata? }';

/** Check `--server` `resolve` params. */
export function parseRunParams(params: unknown = {}): RunRequest {
  const parsed = ResolveParamsSchema.safeParse(params);
  if (!parsed.success) throw new RpcError(INVALID_PARAMS, `${RESOLVE_PARAMS}\n${z.prettifyError(parsed.error)}`);
  const { entry, in: prior, inputs, stripMetadata } = parsed.data;
  return { entry, prior, inputs, stripMetadata };
}

/** The JSON-RPC methods `--server` answers, whichever the transport; with a
 * `session`, each `resolve` continues from and logs to it, and `rewind` cuts it back. */
export const serverMethods = (cwd: string, session?: Session): Methods => ({
  resolve: (params) => {
    const request = parseRunParams(params);
    if (session === undefined) return run(cwd, request);
    if (request.prior !== undefined) throw new RpcError(INVALID_PARAMS, STATEFUL_IN);
    return session.turn(request, (turn) => run(cwd, turn));
  },
  inspect: async (params = {}) => {
    const parsed = InspectParamsSchema.safeParse(params);
    if (!parsed.success) throw new RpcError(INVALID_PARAMS, 'inspect expects { entry?, in? }');
    const { entry, in: prior } = parsed.data;
    if (session === undefined) return inspectState(cwd, entry, prior);
    if (prior !== undefined) throw new RpcError(INVALID_PARAMS, STATEFUL_IN);
    return inspectState(cwd, entry, await session.head(entry));
  },
  export: async (params) => {
    const parsed = ExportParamsSchema.safeParse(params);
    if (!parsed.success) throw new RpcError(INVALID_PARAMS, 'export expects { entry?, in?, actor }');
    const { entry, in: prior, actor } = parsed.data;
    if (session === undefined) return exportState(cwd, { entry, prior, actor });
    if (prior !== undefined) throw new RpcError(INVALID_PARAMS, STATEFUL_IN);
    return exportState(cwd, { entry, prior: await session.head(entry), actor });
  },
  import: (params) => {
    const parsed = ImportParamsSchema.safeParse(params);
    if (!parsed.success) throw new RpcError(INVALID_PARAMS, 'import expects { entry?, in?, path, export }');
    const { entry, in: prior, path, export: payload } = parsed.data;
    const request: RunRequest = { entry, prior, inputs: [{ type: 'import', path, value: readExport(payload) }] };
    if (session === undefined) return run(cwd, request);
    if (prior !== undefined) throw new RpcError(INVALID_PARAMS, STATEFUL_IN);
    return session.turn(request, (turn) => run(cwd, turn));
  },
  ...(session === undefined
    ? {}
    : {
        rewind: (params) => {
          const parsed = RewindParamsSchema.safeParse(params);
          if (!parsed.success) throw new RpcError(INVALID_PARAMS, 'rewind expects { version: integer >= 1 }');
          return session.rewind(parsed.data.version);
        },
      }),
});

// Entry point only — no-op when imported (e.g. by tests).
if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    const session = await match(args)
      .with({ server: P.nullish }, { stateless: true }, () => undefined)
      .with({ session: P.string }, ({ session: id, history }) => Session.resume({ id, history }))
      .otherwise(({ history }) => new Session({ history }));
    const methods = serverMethods(process.cwd(), session);
    if (args.server === 'stdio') {
      const server = new StdioServer(methods, args.format);
      await server.serve(process.stdin, (bytes) => process.stdout.write(bytes));
      process.exit(0);
    }
    if (args.server === 'http') {
      // Loopback only: `entry` names files on this machine, so the server must not answer other hosts.
      const { fetch } = new HttpServer(methods, args.format);
      const server = Bun.serve({ hostname: '127.0.0.1', port: args.port ?? DEFAULT_PORT, fetch });
      console.error(`listening on ${server.url}`);
    } else if (args.server === 'websocket') {
      const { fetch, websocket } = new WebSocketServer(methods, args.format);
      const server = Bun.serve({ hostname: '127.0.0.1', port: args.port ?? DEFAULT_PORT, fetch, websocket });
      console.error(`listening on ${server.url.href.replace(/^http/, 'ws')}`);
    } else {
      const read = async (file: string) =>
        JSON.parse(file === '-' ? await Bun.stdin.text() : await Bun.file(file).text());
      const prior = args.in === undefined ? undefined : await read(args.in);
      const inputs =
        args.import === undefined
          ? args.events
          : [{ type: 'import' as const, path: args.import.path, value: readExport(await read(args.import.file)) }];
      const out =
        args.export === undefined
          ? await run(process.cwd(), { entry: args.entry, prior, inputs, stripMetadata: args.stripMetadata })
          : await exportState(process.cwd(), { entry: args.entry, prior, actor: args.export });
      const json = `${JSON.stringify(out, null, args.compact ? 0 : 2)}\n`;
      // A state that resolves or asks can be saved; Bun.write replaces the file.
      if (args.out !== undefined && !(out !== null && typeof out === 'object' && 'errors' in out))
        await Bun.write(args.out, json);
      process.stdout.write(json);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
