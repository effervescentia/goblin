/**
 * Character sheet demo (Bun-only): spawns a stateful `goblin --server websocket`
 * and serves a page that talks to it through `goblin/client`.
 *
 *   bun run demo          # http://localhost:1338
 */
import { listening, spawnServer, stop } from '@/client/spawn';
import index from './index.html';

const root = `${import.meta.dir}/..`;

const goblin = await spawnServer(
  { command: process.execPath, args: ['src/cli/cli.ts'], cwd: root },
  'websocket',
  'cbor',
  0,
);
const url = await listening(goblin);

const server = Bun.serve({
  port: Number(process.env.PORT ?? 1338),
  routes: {
    '/': index,
    '/api/goblin': () => Response.json({ url }),
  },
});

console.log(`goblin character sheet on ${server.url} (engine at ${url})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await stop(goblin);
    process.exit(0);
  });
}
