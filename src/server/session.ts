/**
 * A stateful server's history: one append-only CBOR Sequence (RFC 8742) per session at
 * `<root>/<id>/log.cbor`, an item per answered turn. The first item is a checkpoint holding every
 * event up to its version; each later one holds only what its turn added. `manifest.json` names the
 * `entry`, the head `version` and each version's byte `offsets`, so rewinding is a truncate.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, truncate, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Decoder, Encoder } from 'cbor-x';
import z from 'zod';

const SESSIONS_DIR = join('.goblin', 'sessions');
const LOG = 'log.cbor';
const DEFAULT_HISTORY = 30;

/** The keys a stateful server adds to each `resolve` answer, beside the envelope (and outside its `hash`). */
export interface Turn {
  /** The version this turn continued from, or null when it started fresh. */
  previous: number | null;
  sessionID: string;
}

interface SessionOptions {
  /** Where session directories go; `~/.goblin/sessions` unless given. */
  root?: string;
  /** Reopen this session's log instead of starting a new one. */
  id?: string;
  /** How many versions, the head among them, a session can rewind to. */
  history?: number;
}

/** One logged turn. `events` follow the previous item's first `at` (all of them unless given): a new
 * input can reweave writes made before an earlier invoke, so a stream is not always a pure append. */
const ItemSchema = z.object({
  version: z.int().min(1),
  entry: z.string().nullable(),
  at: z.int().nonnegative().optional(),
  events: z.array(z.unknown()),
  hash: z.string(),
  /** What the turn still asks for; a turn without one resolved to `{ data }`. */
  query: z.unknown().optional(),
});

type Item = z.infer<typeof ItemSchema>;

/** A logged item, where it starts in the log and the whole event stream as of its version. */
interface Link {
  item: Item;
  offset: number;
  events: unknown[];
}

const CBOR = { mapsAsObjects: true, useRecords: false };

export class Session {
  readonly id: string;
  readonly dir: string;
  private readonly log: string;
  private readonly history: number;
  private readonly encoder = new Encoder(CBOR);
  private chain: Link[] = [];
  private size = 0;
  private readonly loaded: Promise<void>;
  private queue: Promise<unknown>;

  constructor({
    root = join(homedir(), SESSIONS_DIR),
    id = randomUUID(),
    history = DEFAULT_HISTORY,
  }: SessionOptions = {}) {
    this.id = id;
    this.dir = join(root, id);
    this.log = join(this.dir, LOG);
    this.history = history;
    // A corrupt log fails every call rather than being overwritten.
    this.loaded = this.load();
    this.queue = this.loaded.catch(() => undefined);
  }

  /** Reopen a session saved before, failing when it logged no turn. */
  static async resume(options: SessionOptions & { id: string }): Promise<Session> {
    const session = new Session(options);
    await session.loaded;
    if (session.chain.length === 0) throw new Error(`no session ${options.id} to continue in ${dirname(session.dir)}`);
    return session;
  }

  /** Run one turn from the head (unless it names another entry, which starts a fresh log) and log what it
   * answers. Turns run one at a time, so overlapping requests still form a single chain. */
  turn<R extends { entry?: string }>(
    request: R,
    run: (request: R & { prior?: unknown }) => Promise<unknown>,
  ): Promise<unknown> {
    return this.enqueue(async () => {
      const entry = request.entry ?? null;
      const head = this.chain.at(-1);
      const from = head?.item.entry === entry ? head : undefined;
      const out = await run(from === undefined ? request : { ...request, prior: priorOf(from) });
      // Like `--out`, a failing `{ errors }` answer is not a state to continue from.
      if (isRecord(out) && !('errors' in out)) await this.append(entry, out, from);
      return { ...(isRecord(out) ? out : {}), previous: from?.item.version ?? null, sessionID: this.id } satisfies Turn;
    });
  }

  /** The head as `turn` would continue from it for `entry`, or undefined when the log holds another entry or none. */
  head(entry?: string): Promise<unknown> {
    return this.enqueue(async () => {
      const head = this.chain.at(-1);
      return head?.item.entry === (entry ?? null) ? priorOf(head) : undefined;
    });
  }

  /** Cut the log back to `version`, one of the latest `history`, so the next turn continues from it. */
  rewind(version: number): Promise<{ version: number; sessionID: string }> {
    return this.enqueue(async () => {
      const at = this.chain.findIndex((link) => link.item.version === version);
      const oldest = this.chain.at(-this.history)?.item.version ?? this.chain[0]?.item.version;
      if (at === -1 || at < this.chain.length - this.history)
        throw new Error(
          oldest === undefined
            ? 'nothing to rewind: the session has no turns'
            : `can only rewind to versions ${oldest}..${this.chain.at(-1)?.item.version}, got: ${version}`,
        );
      const next = this.chain[at + 1];
      if (next !== undefined) {
        await truncate(this.log, next.offset);
        this.size = next.offset;
        this.chain.length = at + 1;
        await this.writeManifest();
      }
      return { version, sessionID: this.id };
    });
  }

  private enqueue<T>(step: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => this.loaded).then(step);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async append(entry: string | null, out: Record<string, unknown>, from: Link | undefined): Promise<void> {
    // The hash covers the JSON form, so log that rather than what CBOR could keep (`undefined`).
    const { version, events, hash, query } = JSON.parse(JSON.stringify(out)) as Item;
    const before = from?.events ?? [];
    const at = from === undefined ? before.length : sharedPrefix(before, events);
    const item: Item = {
      version,
      entry,
      ...(at < before.length ? { at } : {}),
      events: events.slice(at),
      hash,
      ...(query === undefined ? {} : { query }),
    };
    if (from === undefined) {
      await mkdir(this.dir, { recursive: true });
      await this.rewrite([{ item, offset: 0, events }]);
    } else {
      const bytes = this.encoder.encode(item);
      await appendFile(this.log, bytes);
      this.chain.push({ item, offset: this.size, events });
      this.size += bytes.length;
      // Compacting lags until twice over, so most turns are a bare append.
      if (this.chain.length > 2 * this.history) await this.rewrite(this.chain.slice(-this.history));
    }
    await this.writeManifest();
  }

  /** Replace the log with `links`, the first rewritten as a checkpoint; swapped in whole by a rename. */
  private async rewrite(links: Link[]): Promise<void> {
    let offset = 0;
    const encoded = links.map(({ item, events }, i) => {
      const { at: _, ...whole } = item;
      const logged = i === 0 ? { ...whole, events } : item;
      const bytes = this.encoder.encode(logged);
      const link = { item: logged, offset, events };
      offset += bytes.length;
      return { link, bytes };
    });
    const temp = `${this.log}.tmp`;
    await writeFile(temp, Buffer.concat(encoded.map(({ bytes }) => bytes)));
    await rename(temp, this.log);
    this.chain = encoded.map(({ link }) => link);
    this.size = offset;
  }

  private async writeManifest(): Promise<void> {
    const head = this.chain.at(-1);
    const offsets = Object.fromEntries(this.chain.map((link) => [link.item.version, link.offset]));
    const body = { entry: head?.item.entry ?? null, version: head?.item.version ?? null, offsets };
    await writeFile(join(this.dir, 'manifest.json'), `${JSON.stringify(body, null, 2)}\n`);
  }

  /** Read back a log this session wrote before, cutting off an item a crash left half-written. */
  private async load(): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(this.log);
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return;
      throw err;
    }
    const corrupt = (why: string) => new Error(`session log ${this.log} is corrupt: ${why}`);
    const items: Item[] = [];
    let valid = bytes.length;
    try {
      if (bytes.length > 0) new Decoder(CBOR).decodeMultiple(bytes, (item) => void items.push(item as Item));
    } catch (err) {
      const torn = err as { incomplete?: boolean; lastPosition?: number };
      if (!torn.incomplete) throw corrupt((err as Error).message);
      valid = torn.lastPosition ?? 0;
    }
    if (!z.array(ItemSchema).safeParse(items).success) throw corrupt('an item is not a logged turn');
    // Items are JSON-clean, so each re-encodes to its own bytes; that finds the offsets cbor-x keeps to itself.
    let offset = 0;
    let events: unknown[] = [];
    this.chain = items.map((item) => {
      events = [...events.slice(0, item.at ?? events.length), ...item.events];
      const link = { item, offset, events };
      offset += this.encoder.encode(item).length;
      return link;
    });
    if (offset !== valid) throw corrupt('its items do not add up to its size');
    if (valid < bytes.length) await truncate(this.log, valid);
    this.size = valid;
    if (this.chain.length > 0) await this.writeManifest();
  }
}

/** The prior a turn continues from. The log is the session's own, so it skips the hash check; `data` is
 * only a marker that the head resolved, since `run` re-resolves the entry anyway. */
const priorOf = ({ item, events }: Link) => ({
  version: item.version,
  events,
  ...(item.query === undefined ? { data: null } : { query: item.query }),
});

function sharedPrefix(before: unknown[], after: unknown[]): number {
  let at = 0;
  while (at < before.length && at < after.length && JSON.stringify(before[at]) === JSON.stringify(after[at])) at++;
  return at;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
