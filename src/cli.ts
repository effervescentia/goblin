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
import { serialize } from './utils';

export const USAGE = `goblin [entry.yaml] [--compact] [--help]

Resolves a goblin document and prints the application state as JSON.

Arguments:
  entry.yaml    Entry document (default: main from .goblin.yaml).
                If it contains a directory, $.tmpl('…') resolves relative to it.
  --compact     Single-line JSON output (default: pretty-printed).
  --help, -h    Show this help.`;

export interface CliArgs {
  entry?: string;
  compact: boolean;
  help: boolean;
}

/** Pure argv parsing (excludes node/bun binary and script name). */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { compact: false, help: false };
  for (const arg of argv) {
    if (arg === '--compact') {
      args.compact = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (!arg.startsWith('-') && args.entry === undefined) {
      args.entry = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return args;
}

export async function resolveAppState(cwd: string, entry?: string): Promise<unknown> {
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
  return serialize(engine.evaluateDoc(main));
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
    const state = await resolveAppState(process.cwd(), args.entry);
    process.stdout.write(`${JSON.stringify(state, null, args.compact ? 0 : 2)}\n`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
