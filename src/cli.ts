#!/usr/bin/env bun
/**
 * Goblin CLI — resolves the application state and prints it as JSON.
 *
 * Usage:
 *   goblin [entry.yaml] [--compact] [--out file.json] [--help]
 *
 * With no entry file, `.goblin.yaml` in the current directory is required.
 * An entry containing a directory (`examples/foo.yaml`) is resolved with
 * that directory as the root, so `$tmpl('…')` paths are relative to it.
 * Resolved state goes to stdout (always valid JSON); errors go to stderr
 * with a non-zero exit code.
 */
import { GoblinEngine } from './engine';
import { print } from './nodes/serialize';

export const USAGE = `goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--strip-metadata] [--out file.json] [--help]

Resolves a goblin document and prints the result as JSON: either
{ "data": … } when all :param values are satisfied, or
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
  --out         Also write the JSON to this file (replacing it) when the
                document fully resolves to { "data": … }; a { "query" } or
                { "errors" } result leaves the file untouched.
  --help, -h    Show this help.`;

export interface CliArgs {
  entry?: string;
  compact: boolean;
  stripMetadata: boolean;
  help: boolean;
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
    const state = await resolveAppState(process.cwd(), args.entry, args.params, args.overrides);
    const out = args.stripMetadata && 'data' in state ? { data: print((state as { data: unknown }).data) } : state;
    const json = `${JSON.stringify(out, null, args.compact ? 0 : 2)}\n`;
    // Only a full resolution is worth saving; Bun.write replaces the file.
    if (args.out !== undefined && 'data' in state) await Bun.write(args.out, json);
    process.stdout.write(json);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
