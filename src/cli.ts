#!/usr/bin/env bun
/**
 * Goblin CLI — resolves the application state and prints it as JSON.
 *
 * Usage:
 *   goblin [entry.yaml] [--compact] [--help]
 *
 * With no entry file, the main document from `.goblin.yaml` is used.
 * An entry containing a directory (`examples/foo.yaml`) is resolved with
 * that directory as the root, so `$.tmpl('…')` paths are relative to it.
 * Resolved state goes to stdout (always valid JSON); errors go to stderr
 * with a non-zero exit code.
 */
import { GoblinEngine } from './engine';

export const USAGE = `goblin [entry.yaml] [--compact] [--param key=value] [--help]

Resolves a goblin document and prints the result as JSON: either
{ "data": … } when all :param values are satisfied, or
{ "query": […] } listing the outstanding parameters.

Arguments:
  entry.yaml    Entry document (default: main from .goblin.yaml).
                If it contains a directory, $.tmpl('…') resolves relative to it.
  --compact     Single-line JSON output (default: pretty-printed).
  --param       Provide a :param value (repeatable). Values parse as JSON,
                falling back to strings: --param level=3 --param name=Aria
  --help, -h    Show this help.`;

export interface CliArgs {
  entry?: string;
  compact: boolean;
  help: boolean;
  params: Record<string, unknown>;
}

/** Parse a --param value as JSON, falling back to a plain string. */
export function parseParamValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Pure argv parsing (excludes node/bun binary and script name). */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { compact: false, help: false, params: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--compact') {
      args.compact = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--param') {
      const pair = argv[++i];
      const eq = pair?.indexOf('=') ?? -1;
      if (pair === undefined || eq <= 0) throw new Error(`--param expects key=value, got: ${pair ?? '(nothing)'}`);
      args.params[pair.slice(0, eq)] = parseParamValue(pair.slice(eq + 1));
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
    // Resolve relative to the entry's own directory so `$.tmpl('…')`
    // references stay local to it.
    const slash = main.lastIndexOf('/');
    root = main.startsWith('/') ? main.slice(0, slash) : `${cwd}/${main.slice(0, slash)}`;
    main = main.slice(slash + 1);
  }
  const engine = new GoblinEngine(root);
  await preloadTemplates(engine, root, main);
  await engine.loadFile(main);
  return engine.resolve(main, provided);
}

/**
 * `$.tmpl('other.yaml')` resolves synchronously at eval time, so every
 * referenced template must be loaded up front. Scans raw file text for
 * references and loads them recursively.
 */
async function preloadTemplates(engine: GoblinEngine, root: string, file: string): Promise<void> {
  const seen = new Set<string>();
  const queue = [file];
  const pattern = /\$\.tmpl\(\s*['"]([^'"]+)['"]\s*\)/g;
  while (queue.length > 0) {
    const next = queue.pop() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    const text = await Bun.file(`${root}/${next}`.replace(/\/\//g, '/')).text();
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    match = pattern.exec(text);
    while (match !== null) {
      queue.push(match[1] as string);
      match = pattern.exec(text);
    }
  }
  for (const name of seen) {
    if (!engine.docs.has(name)) {
      await engine.loadFile(name);
    }
  }
}

// Entry point only — no-op when imported (e.g. by tests).
if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    const state = await resolveAppState(process.cwd(), args.entry, args.params);
    process.stdout.write(`${JSON.stringify(state, null, args.compact ? 0 : 2)}\n`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
