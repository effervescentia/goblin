import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeMultiple } from 'cbor-x';
import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from '@/client/client';
import type { ClientOptions, Spawn } from '@/client/dtos';
import { listening, spawnServer, stop } from '@/client/spawn';

// Drives a real `goblin --server` of every transport, shelled out to `bun` so this works under any runtime.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Stateful servers save under ~/.goblin, so give them a home of their own.
const home = mkdtempSync(join(tmpdir(), 'goblin-home-'));
const spawn: Spawn = { command: 'bun', args: ['src/cli/cli.ts'], cwd: root, env: { HOME: home } };
const stateless: Spawn = { ...spawn, args: ['src/cli/cli.ts', '--stateless'] };
afterAll(() => rmSync(home, { recursive: true, force: true }));
const sessionDir = (id: string) => join(home, '.goblin', 'sessions', id);
const answers = [
  { type: 'parameter', path: 'hero_name', value: 'Aria' },
  { type: 'parameter', path: 'starting_level', value: 3 },
  { type: 'parameter', path: 'details.title', value: 'Sir' },
] as const;
const answered = () =>
  cli(entry, '--param', 'hero_name=Aria', '--param', 'starting_level=3', '--param', 'details.title=Sir').data;
const entry = 'examples/08-parameters.yaml';

const cli = (...args: string[]) =>
  JSON.parse(execFileSync('bun', ['src/cli/cli.ts', ...args], { cwd: root, encoding: 'utf8' }));

const pick = (envelope: object, ...keys: string[]) =>
  Object.fromEntries(Object.entries(envelope).filter(([key]) => keys.includes(key)));

const TRANSPORTS = ['stdio', 'http', 'websocket'] as const;
const FORMATS = ['cbor', 'json'] as const;

describe.each(TRANSPORTS.flatMap((transport) => FORMATS.map((format) => [transport, format] as const)))(
  'createClient %s over %s, spawning the server',
  (transport, format) => {
    it('resolves turns to the envelopes a one-shot run prints, continuing from the logged head', async () => {
      const client = await createClient({ transport, format, spawn } as ClientOptions);
      try {
        const { previous, sessionID, ...asking } = await client.resolve({ entry });
        expect(asking).toEqual(cli(entry));
        expect(previous).toBeNull();
        expect(sessionID).toMatch(/^[0-9a-f-]{36}$/);
        const dir = sessionDir(String(sessionID));
        const manifest = () => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
        expect(manifest()).toEqual({ entry, version: 1, offsets: { 1: 0 } });

        // No `in`: the server picks up from its log, landing where a one-shot `--in` run does.
        const { previous: from, sessionID: same, ...next } = await client.resolve({ entry, inputs: [...answers] });
        expect({ previous: from, sessionID: same }).toEqual({ previous: 1, sessionID });
        const saved = join(home, `${sessionID}.json`);
        writeFileSync(saved, JSON.stringify(asking));
        expect(next).toEqual(cli(entry, '--in', saved, ...answers.flatMap((a) => ['--param', `${a.path}=${a.value}`])));
        expect(manifest()).toMatchObject({ version: 2 });
        expect(readdirSync(dir).sort()).toEqual(['log.cbor', 'manifest.json']);
        const [checkpoint, turn] = decodeMultiple(readFileSync(join(dir, 'log.cbor'))) as unknown[];
        expect(checkpoint).toEqual({ version: 1, entry, events: [], ...pick(asking, 'hash', 'query') });
        expect(turn).toEqual({ version: 2, entry, ...pick(next, 'events', 'hash') });

        // The log is the session's own: it takes no `in`, but can rewind.
        await expect(client.resolve({ entry, in: asking })).rejects.toMatchObject({ code: -32602 });
        expect(await client.rewind(1)).toEqual({ version: 1, sessionID });
        expect(await client.resolve({ entry })).toMatchObject({ version: 2, previous: 1, sessionID });
        await expect(client.rewind(0)).rejects.toMatchObject({ code: -32602 });
        await expect(client.resolve({ entry: 'nope.yaml' })).rejects.toMatchObject({ code: -32000 });
      } finally {
        await client.close();
      }
    });

    it('answers each call on its own with --stateless', async () => {
      const client = await createClient({ transport, format, spawn: stateless } as ClientOptions);
      try {
        const asking = await client.resolve({ entry });
        expect(asking).toEqual(cli(entry));
        const next = await client.resolve({ entry, in: asking, inputs: [...answers] });
        expect(next).toMatchObject({ version: 2 });
        expect('data' in next && next.data).toEqual(answered());
        expect(await client.resolve({ entry })).toEqual(cli(entry));
      } finally {
        await client.close();
      }
    });
  },
);

describe('createClient resuming a session', () => {
  it("continues a closed server's session with --session", async () => {
    const first = await createClient({ transport: 'stdio', spawn });
    const { sessionID } = await first.resolve({ entry });
    await first.close();
    const resumed = { ...spawn, args: ['src/cli/cli.ts', '--session', String(sessionID)] };
    const second = await createClient({ transport: 'stdio', spawn: resumed });
    try {
      const next = await second.resolve({ entry, inputs: [...answers] });
      expect(next).toMatchObject({ version: 2, previous: 1, sessionID });
      expect('data' in next && next.data).toEqual(answered());
    } finally {
      await second.close();
    }
  });

  it('fails to start on a session that was never saved', async () => {
    const missing = { ...spawn, args: ['src/cli/cli.ts', '--session', '0b6c3a0e-6f1d-4c8e-9a51-2f4d7c9e1b3a'] };
    await expect(createClient({ transport: 'http', spawn: missing })).rejects.toThrow('server exited (1)');
  });
});

describe('createClient spawning a server that will not start', () => {
  const broken: Spawn = { ...spawn, args: ['missing.ts'] };

  it.each(['http', 'websocket'] as const)('rejects %s with why it exited', async (transport) => {
    await expect(createClient({ transport, spawn: broken })).rejects.toThrow('server exited (1)');
  });

  it('fails stdio calls with why it exited', async () => {
    const client = await createClient({ transport: 'stdio', spawn: broken });
    await expect(client.resolve()).rejects.toThrow('server exited (1)');
  });
});

describe('createClient connecting to a running server', () => {
  it.each(['http', 'websocket'] as const)('reaches %s at the url it logs', async (transport) => {
    const server = await spawnServer(spawn, transport, 'json', 0);
    try {
      const client = await createClient({ transport, format: 'json', url: await listening(server) });
      expect(await client.resolve({ entry })).toMatchObject({ ...cli(entry), previous: null });
      await client.close();
    } finally {
      await stop(server);
    }
  });
});
