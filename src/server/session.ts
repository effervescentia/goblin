/**
 * A stateful server's history: every envelope it answers is saved as
 * `<root>/<id>/state_<timestamp>.json`, and `head.json` names the latest (`state`)
 * and the `entry` it resolved; the next turn continues from it unless it brings its own `in`.
 * Only the latest `history` states are kept.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSIONS_DIR = join('.goblin', 'sessions');
const DEFAULT_HISTORY = 30;

/** The keys a stateful server adds to each `resolve` answer, beside the envelope (and outside its `hash`). */
export interface Turn {
  /** The state file this turn continued from, or null when it started fresh or was given `in`. */
  previous: string | null;
  sessionID: string;
}

interface SessionOptions {
  /** Where session directories go; `~/.goblin/sessions` unless given. */
  root?: string;
  /** How many `state_*.json` files to keep, the oldest deleted first. */
  history?: number;
}

export class Session {
  readonly id = randomUUID();
  readonly dir: string;
  private readonly history: number;
  /** This session's state files, oldest first. */
  private readonly saved: string[] = [];
  private head?: { entry?: string; name: string; state: unknown };
  private stamp = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor({ root = join(homedir(), SESSIONS_DIR), history = DEFAULT_HISTORY }: SessionOptions = {}) {
    this.dir = join(root, this.id);
    this.history = history;
  }

  /** Run one turn from the head (unless `request` has a `prior`, or names another entry) and save what it
   * answers as the new head. Turns run one at a time, so overlapping requests still form a single chain. */
  turn<R extends { entry?: string; prior?: unknown }>(
    request: R,
    run: (request: R) => Promise<unknown>,
  ): Promise<unknown> {
    const next = this.queue.then(async () => {
      const head = request.prior === undefined && this.head?.entry === request.entry ? this.head : undefined;
      const out = await run(head === undefined ? request : { ...request, prior: head.state });
      // Like `--out`, a failing `{ errors }` answer is not a state to continue from.
      if (isRecord(out) && !('errors' in out)) await this.save(request.entry, out);
      return { ...(isRecord(out) ? out : {}), previous: head?.name ?? null, sessionID: this.id } satisfies Turn;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async save(entry: string | undefined, state: Record<string, unknown>): Promise<void> {
    // Strictly increasing, so two turns in one millisecond still get their own file.
    this.stamp = Math.max(Date.now(), this.stamp + 1);
    const name = `state_${this.stamp}.json`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, name), `${JSON.stringify(state, null, 2)}\n`);
    await writeFile(join(this.dir, 'head.json'), `${JSON.stringify({ entry: entry ?? null, state: name }, null, 2)}\n`);
    this.head = { entry, name, state };
    // Pruned only once head.json has moved on, so it never names a deleted state.
    this.saved.push(name);
    for (const old of this.saved.splice(0, Math.max(0, this.saved.length - this.history)))
      await rm(join(this.dir, old), { force: true });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
