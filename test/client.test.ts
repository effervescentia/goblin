import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createClient } from '@/client/client';
import type { ClientOptions, Spawn } from '@/client/dtos';
import { listening, spawnServer, stop } from '@/client/spawn';

// Drives a real `goblin --server` of every transport, shelled out to `bun` so this works under any runtime.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spawn: Spawn = { command: 'bun', args: ['src/cli/cli.ts'], cwd: root };
const entry = 'examples/08-parameters.yaml';

const cli = (...args: string[]) =>
  JSON.parse(execFileSync('bun', ['src/cli/cli.ts', ...args], { cwd: root, encoding: 'utf8' }));

const TRANSPORTS = ['stdio', 'http', 'websocket'] as const;
const FORMATS = ['cbor', 'json'] as const;

describe.each(TRANSPORTS.flatMap((transport) => FORMATS.map((format) => [transport, format] as const)))(
  'createClient %s over %s, spawning the server',
  (transport, format) => {
    it('resolves turns to the envelopes a one-shot run prints', async () => {
      const client = await createClient({ transport, format, spawn } as ClientOptions);
      try {
        const asking = await client.resolve({ entry });
        expect(asking).toEqual(cli(entry));
        const answered = await client.resolve({
          entry,
          in: asking,
          inputs: [
            { type: 'parameter', path: 'hero_name', value: 'Aria' },
            { type: 'parameter', path: 'starting_level', value: 3 },
            { type: 'parameter', path: 'details.title', value: 'Sir' },
          ],
        });
        expect(answered).toMatchObject({ version: 2 });
        expect('data' in answered && answered.data).toEqual(
          cli(entry, '--param', 'hero_name=Aria', '--param', 'starting_level=3', '--param', 'details.title=Sir').data,
        );
        await expect(client.resolve({ entry: 'nope.yaml' })).rejects.toMatchObject({ code: -32000 });
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
      expect(await client.resolve({ entry })).toEqual(cli(entry));
      await client.close();
    } finally {
      await stop(server);
    }
  });
});
