import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from './session';

type Request = { entry?: string; prior?: unknown; n?: number };

/** A stand-in for `run`: the next version on from `prior`. */
const run = async ({ prior, n }: Request) => ({
  version: ((prior as { version?: number } | undefined)?.version ?? 0) + 1,
  ...(n === undefined ? {} : { n }),
});

describe('Session', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'goblin-session-'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const head = async (session: Session) => JSON.parse(await readFile(join(session.dir, 'head.json'), 'utf8'));

  it('keeps each server instance under its own uuid, writing nothing until it answers', async () => {
    const [a, b] = [new Session(root), new Session(root)];
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.dir).toBe(join(root, a.id));
    expect(await readdir(root)).toEqual([]);
  });

  it('chains turns through head.json, naming the state each continued from', async () => {
    const session = new Session(root);
    const first = await session.turn({ entry: 'a.yaml' }, run);
    expect(first).toEqual({ version: 1, previous: null, sessionID: session.id });
    const { entry, state: name } = await head(session);
    expect(entry).toBe('a.yaml');
    expect(name).toMatch(/^state_\d+\.json$/);
    expect(JSON.parse(await readFile(join(session.dir, name), 'utf8'))).toEqual({ version: 1 });

    expect(await session.turn({ entry: 'a.yaml' }, run)).toEqual({ version: 2, previous: name, sessionID: session.id });
    const files = await readdir(session.dir);
    expect(files).toHaveLength(3);
    expect(files).toContain((await head(session)).state);
  });

  it('starts from a given prior instead of the head, still saving the answer', async () => {
    const session = new Session(root);
    await session.turn({}, run);
    await session.turn({}, run);
    expect(await session.turn({ prior: { version: 10 } }, run)).toEqual({
      version: 11,
      previous: null,
      sessionID: session.id,
    });
    expect(await session.turn({}, run)).toMatchObject({ version: 12 });
  });

  it('starts fresh when the entry changes, and the head follows it', async () => {
    const session = new Session(root);
    await session.turn({ entry: 'a.yaml' }, run);
    expect(await session.turn({ entry: 'b.yaml' }, run)).toMatchObject({ version: 1, previous: null });
    expect((await head(session)).entry).toBe('b.yaml');
    expect(await session.turn({ entry: 'b.yaml' }, run)).toMatchObject({ version: 2 });
    expect(await session.turn({ entry: 'a.yaml' }, run)).toMatchObject({ version: 1, previous: null });
    expect(await session.turn({}, run)).toMatchObject({ version: 1, previous: null });
    expect((await head(session)).entry).toBeNull();
  });

  it('runs overlapping turns one at a time, each on the last', async () => {
    const session = new Session(root);
    const answers = await Promise.all([1, 2, 3].map((n) => session.turn({ n }, run)));
    expect(answers.map((answer) => (answer as { version: number }).version)).toEqual([1, 2, 3]);
    expect(new Set(await readdir(session.dir)).size).toBe(4);
  });

  it('saves no { errors } answer, and survives a failing turn', async () => {
    const session = new Session(root);
    await session.turn({}, run);
    const before = await head(session);
    expect(await session.turn({}, async () => ({ errors: ['bad'] }))).toMatchObject({ errors: ['bad'] });
    await expect(
      session.turn({}, async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(await head(session)).toEqual(before);
    expect(await session.turn({}, run)).toMatchObject({ version: 2 });
  });
});
