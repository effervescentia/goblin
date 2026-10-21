import { appendFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeMultiple } from 'cbor-x';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from './session';

type Request = { entry?: string; ask?: boolean; reweave?: boolean };
type Prior = { version: number; events: { version: number; path: string }[]; query?: unknown };

/** A stand-in for `run`: the next version on from `prior`, with one new event (or, to `reweave`, two around the rest). */
const run = async ({ prior, ask, reweave }: Request & { prior?: unknown }) => {
  const { version: last = 0, events = [] } = (prior ?? {}) as Partial<Prior>;
  const version = last + 1;
  const made = { version, path: `p${version}` };
  return {
    hash: `sha256:${version}`,
    version,
    events: reweave ? [made, ...events, { ...made, path: 'late' }] : [...events, made],
    ...(ask ? { query: [{ path: 'name' }] } : { data: { version } }),
  };
};

describe('Session', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'goblin-session-'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const manifest = async (session: Session) => JSON.parse(await readFile(join(session.dir, 'manifest.json'), 'utf8'));
  const items = async (session: Session) => decodeMultiple(await readFile(join(session.dir, 'log.cbor'))) as unknown[];

  it('keeps each server instance under its own uuid, writing nothing until it answers', async () => {
    const [a, b] = [new Session({ root }), new Session({ root })];
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.dir).toBe(join(root, a.id));
    expect(await readdir(root)).toEqual([]);
  });

  it('appends one item per turn after a checkpoint, indexing each version by offset', async () => {
    const session = new Session({ root });
    const first = await session.turn({ entry: 'a.yaml' }, run);
    expect(first).toMatchObject({ version: 1, data: { version: 1 }, previous: null, sessionID: session.id });
    const size = (await stat(join(session.dir, 'log.cbor'))).size;

    expect(await session.turn({ entry: 'a.yaml' }, run)).toMatchObject({ version: 2, previous: 1 });
    expect(await session.turn({ entry: 'a.yaml', ask: true }, run)).toMatchObject({ version: 3, previous: 2 });
    expect(await items(session)).toEqual([
      { version: 1, entry: 'a.yaml', events: [{ version: 1, path: 'p1' }], hash: 'sha256:1' },
      { version: 2, entry: 'a.yaml', events: [{ version: 2, path: 'p2' }], hash: 'sha256:2' },
      {
        version: 3,
        entry: 'a.yaml',
        events: [{ version: 3, path: 'p3' }],
        hash: 'sha256:3',
        query: [{ path: 'name' }],
      },
    ]);
    const { entry, version, offsets } = await manifest(session);
    expect({ entry, version }).toEqual({ entry: 'a.yaml', version: 3 });
    expect(offsets[1]).toBe(0);
    expect(offsets[2]).toBe(size);
    expect((await readdir(session.dir)).sort()).toEqual(['log.cbor', 'manifest.json']);
  });

  it('continues from the whole stream, telling a head that still asks from one that resolved', async () => {
    const session = new Session({ root });
    const priors: unknown[] = [];
    const spy = (request: Request & { prior?: unknown }) => {
      priors.push(request.prior);
      return run(request);
    };
    await session.turn({ ask: true }, spy);
    await session.turn({}, spy);
    await session.turn({}, spy);
    expect(priors).toEqual([
      undefined,
      { version: 1, events: [{ version: 1, path: 'p1' }], query: [{ path: 'name' }] },
      {
        version: 2,
        events: [
          { version: 1, path: 'p1' },
          { version: 2, path: 'p2' },
        ],
        data: null,
      },
    ]);
  });

  it('logs only where a rewoven stream departs from the last', async () => {
    const session = new Session({ root });
    await session.turn({}, run);
    const rewoven = await session.turn({ reweave: true }, run);
    expect((await items(session))[1]).toEqual({
      version: 2,
      entry: null,
      at: 0,
      events: (rewoven as Prior).events,
      hash: 'sha256:2',
    });
    const reopened = new Session({ root, id: session.id });
    expect(await reopened.turn({}, run)).toMatchObject({
      version: 3,
      events: [...(rewoven as Prior).events, { version: 3, path: 'p3' }],
    });
  });

  it('starts a fresh log when the entry changes', async () => {
    const session = new Session({ root });
    await session.turn({ entry: 'a.yaml' }, run);
    await session.turn({ entry: 'a.yaml' }, run);
    expect(await session.turn({ entry: 'b.yaml' }, run)).toMatchObject({ version: 1, previous: null });
    expect(await manifest(session)).toEqual({ entry: 'b.yaml', version: 1, offsets: { 1: 0 } });
    expect(await items(session)).toHaveLength(1);
    expect(await session.turn({ entry: 'b.yaml' }, run)).toMatchObject({ version: 2, previous: 1 });
    expect(await session.turn({}, run)).toMatchObject({ version: 1, previous: null });
    expect((await manifest(session)).entry).toBeNull();
  });

  it('runs overlapping turns one at a time, each on the last', async () => {
    const session = new Session({ root });
    const answers = await Promise.all([1, 2, 3].map(() => session.turn({}, run)));
    expect(answers.map((answer) => (answer as { version: number }).version)).toEqual([1, 2, 3]);
    expect(await items(session)).toHaveLength(3);
  });

  it('rewinds to one of the latest --history versions, cutting the log at its index', async () => {
    const session = new Session({ root, history: 3 });
    for (let turn = 0; turn < 4; turn++) await session.turn({}, run);
    const { offsets } = await manifest(session);
    expect(await session.rewind(2)).toEqual({ version: 2, sessionID: session.id });
    expect((await stat(join(session.dir, 'log.cbor'))).size).toBe(offsets[3]);
    expect(await manifest(session)).toMatchObject({ version: 2, offsets: { 1: 0, 2: offsets[2] } });
    expect(await session.turn({}, run)).toMatchObject({ version: 3, previous: 2 });

    await expect(session.rewind(9)).rejects.toThrow('can only rewind to versions 1..3, got: 9');
    await session.turn({}, run);
    await expect(session.rewind(1)).rejects.toThrow('can only rewind to versions 2..4, got: 1');
    await expect(new Session({ root }).rewind(1)).rejects.toThrow('nothing to rewind');
    expect(await session.rewind(3)).toEqual({ version: 3, sessionID: session.id });
  });

  it('folds versions past twice --history into a new checkpoint', async () => {
    const session = new Session({ root, history: 2 });
    for (let turn = 0; turn < 4; turn++) await session.turn({}, run);
    expect(await items(session)).toHaveLength(4);
    await session.turn({}, run);
    const [checkpoint, ...rest] = (await items(session)) as Prior[];
    expect(rest).toHaveLength(1);
    expect(checkpoint).toMatchObject({ version: 4, events: [1, 2, 3, 4].map((v) => ({ version: v, path: `p${v}` })) });
    expect(Object.keys((await manifest(session)).offsets)).toEqual(['4', '5']);
    await expect(session.rewind(3)).rejects.toThrow('can only rewind to versions 4..5');
    expect(await session.turn({}, run)).toMatchObject({ version: 6, previous: 5 });
    expect(await new Session({ root, id: session.id }).turn({}, run)).toMatchObject({
      version: 7,
      events: [1, 2, 3, 4, 5, 6, 7].map((v) => ({ version: v, path: `p${v}` })),
    });
  });

  it('resumes a saved session by id, refusing one that logged nothing', async () => {
    const session = new Session({ root });
    await session.turn({}, run);
    const resumed = await Session.resume({ root, id: session.id });
    expect(await resumed.turn({}, run)).toMatchObject({ version: 2, previous: 1, sessionID: session.id });
    await expect(Session.resume({ root, id: 'missing' })).rejects.toThrow(`no session missing to continue in ${root}`);
  });

  it('reopens a log, cutting off an item a crash left half-written', async () => {
    const session = new Session({ root });
    await session.turn({}, run);
    await session.turn({}, run);
    const log = join(session.dir, 'log.cbor');
    const whole = (await stat(log)).size;
    // The head of a map of four keys, its keys never written.
    await appendFile(log, Uint8Array.of(0xa4, 0x67));
    const reopened = new Session({ root, id: session.id });
    expect(await reopened.turn({}, run)).toMatchObject({ version: 3, previous: 2 });
    expect((await manifest(reopened)).offsets[3]).toBe(whole);
    expect(await items(reopened)).toHaveLength(3);
  });

  it('refuses to touch a log it cannot read', async () => {
    const session = new Session({ root });
    await session.turn({}, run);
    await writeFile(join(session.dir, 'log.cbor'), Uint8Array.of(0xff));
    const reopened = new Session({ root, id: session.id });
    await expect(reopened.turn({}, run)).rejects.toThrow('is corrupt');
    await expect(reopened.rewind(1)).rejects.toThrow('is corrupt');
  });

  it('logs no { errors } answer, and survives a failing turn', async () => {
    const session = new Session({ root });
    await session.turn({}, run);
    const before = await manifest(session);
    expect(await session.turn({}, async () => ({ errors: ['bad'] }))).toMatchObject({ errors: ['bad'] });
    await expect(
      session.turn({}, async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(await manifest(session)).toEqual(before);
    expect(await session.turn({}, run)).toMatchObject({ version: 2 });
  });
});
