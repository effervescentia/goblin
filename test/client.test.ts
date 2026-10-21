import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const TRANSPORTS = ['stdio', 'http', 'websocket'] as const;
const FORMATS = ['cbor', 'json'] as const;

describe.each(TRANSPORTS.flatMap((transport) => FORMATS.map((format) => [transport, format] as const)))(
  'createClient %s over %s, spawning the server',
  (transport, format) => {
    it('resolves turns to the envelopes a one-shot run prints, continuing from the saved head', async () => {
      const client = await createClient({ transport, format, spawn } as ClientOptions);
      try {
        const { previous, sessionID, ...asking } = await client.resolve({ entry });
        expect(asking).toEqual(cli(entry));
        expect(previous).toBeNull();
        expect(sessionID).toMatch(/^[0-9a-f-]{36}$/);
        const dir = sessionDir(String(sessionID));
        const head = () => JSON.parse(readFileSync(join(dir, 'head.json'), 'utf8'));
        const { entry: headEntry, state: first } = head();
        expect(headEntry).toBe(entry);
        expect(JSON.parse(readFileSync(join(dir, first), 'utf8'))).toEqual(asking);

        // No `in`: the server picks up from the state it saved.
        const next = await client.resolve({ entry, inputs: [...answers] });
        expect(next).toMatchObject({ version: 2, previous: first, sessionID });
        expect('data' in next && next.data).toEqual(answered());
        const second = head().state;
        expect(second).not.toBe(first);
        expect(readdirSync(dir).sort()).toEqual(['head.json', first, second].sort());

        // An explicit `in` starts over from it.
        expect(await client.resolve({ entry, in: asking })).toMatchObject({ version: 2, previous: null, sessionID });
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
