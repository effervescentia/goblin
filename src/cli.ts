#!/usr/bin/env bun
/**
 * Goblin CLI — resolves the application state and prints it as JSON.
 *
 * Usage:
 *   goblin [entry.yaml] [--compact] [--help]
 *
 * With no entry file, the main document from `.goblin.yaml` is used.
 * An entry containing a directory (`examples/foo.yaml`) is resolved with
 * that directory as the root, so `$tmpl('…')` paths are relative to it.
 * Resolved state goes to stdout (always valid JSON); errors go to stderr
 * with a non-zero exit code.
 */
import { GoblinEngine } from './engine';
import { RecordNode } from './nodes/record';

export const USAGE = `goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--strip-metadata] [--help]

Resolves a goblin document and prints the result as JSON: either
{ "data": … } when all :param values are satisfied, or
{ "query": […] } listing the outstanding parameters.

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
  --help, -h    Show this help.`;

export interface CliArgs {
  entry?: string;
  compact: boolean;
  stripMetadata: boolean;
  help: boolean;
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

export async function resolveAppState(
  cwd: string,
  entry?: string,
  provided: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): Promise<ReturnType<GoblinEngine['resolve']>> {
  // Bun-only: the CLI entry point always runs under Bun (or compiled).
  const { YAML } = await import('bun');
  let root = cwd;
  let main = entry;
  if (main === undefined) {
    const opts = (await Bun.file(`${cwd}/.goblin.yaml`)
      .text()
      .then((t) => YAML.parse(t))) as { root: string; main: string };
    root = `${cwd}/${opts.root}`;
    main = opts.main;
  } else if (main.includes('/')) {
    // Resolve relative to the entry's own directory so `$tmpl('…')`
    // references stay local to it.
    const slash = main.lastIndexOf('/');
    root = main.startsWith('/') ? main.slice(0, slash) : `${cwd}/${main.slice(0, slash)}`;
    main = main.slice(slash + 1);
  }
  const engine = new GoblinEngine(root);
  await engine.loadFile(main);
  const raw = engine.docs.get(main);
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'actor' in raw) {
    return resolveComposed(engine, raw as Record<string, unknown>, provided, overrides);
  }
  return engine.resolve(main, provided, overrides);
}

/**
 * Entry composition (`actor` + `adopt` keys): resolve the base actor, apply
 * each patch in order, then resolve the merged result. Overrides apply
 * before the first pass (so level derivation and `$if` conditions read them)
 * and again inside `resolveRaw` (so explicit values always win). Patch
 * entries are `$tmpl('…')` expressions (or inline objects); provided values
 * flow into every pass.
 */
export async function resolveComposed(
  engine: GoblinEngine,
  entry: Record<string, unknown>,
  provided: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): Promise<ReturnType<GoblinEngine['resolve']>> {
  const scope = { doc: entry, actor: entry, app: engine.appRoot, current: entry, provided };
  const actorRaw = typeof entry.actor === 'string' ? engine.evalExpr(entry.actor, scope) : structuredClone(entry.actor);
  const adopt = Array.isArray(entry.adopt) ? entry.adopt : [entry.adopt];
  const patches = adopt.map((patch) =>
    typeof patch === 'string' ? engine.evalExpr(patch, scope) : structuredClone(patch),
  );
  engine.applyOverrides(actorRaw, overrides);
  // First pass materializes provided values; patches then gate on the actor.
  engine.evaluate(actorRaw, {
    doc: actorRaw,
    actor: actorRaw,
    app: engine.appRoot,
    current: actorRaw,
    provided,
  });
  for (const patch of patches) engine.applyRaw(actorRaw, patch);
  return engine.resolveRaw(actorRaw, provided, overrides);
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
    const out =
      args.stripMetadata && 'data' in state
        ? { data: RecordNode.stripMetadata((state as { data: unknown }).data) }
        : state;
    process.stdout.write(`${JSON.stringify(out, null, args.compact ? 0 : 2)}\n`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
