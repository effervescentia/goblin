/**
 * Goblin inspector server (Bun-only): serves the UI and resolves entries
 * through the same path as the CLI, adding the flattened node list.
 *
 *   bun run ui            # http://localhost:3000
 */
import { resolve as resolvePath } from 'node:path';
import { resolveApp } from '../src/cli';
import { inspect } from '../src/inspect';
import index from './index.html';

const root = `${import.meta.dir}/..`;

/** Entry candidates: every document outside tooling folders. */
async function entries(): Promise<string[]> {
  const found: string[] = [];
  for await (const file of new Bun.Glob('{5e,examples,wip}/*.yaml').scan(root)) found.push(file);
  return found.sort();
}

interface ResolveRequest {
  entry: string;
  params?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    '/': index,
    '/api/entries': async () => Response.json(await entries()),
    // A document an event cites, read relative to the entry that loaded it.
    '/api/source': async (req) => {
      const url = new URL(req.url);
      const entry = url.searchParams.get('entry') ?? '';
      const file = url.searchParams.get('file') ?? '';
      const dir = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '';
      const path = resolvePath(root, dir, file);
      if (!path.startsWith(`${resolvePath(root)}/`) || !path.endsWith('.yaml')) {
        return new Response('not a document in this project', { status: 400 });
      }
      const source = Bun.file(path);
      if (!(await source.exists())) return new Response('no such document', { status: 404 });
      return new Response(await source.text(), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    },
    '/api/resolve': {
      POST: async (req) => {
        const { entry, params = {}, overrides = {} } = (await req.json()) as ResolveRequest;
        try {
          const { state, actor } = await resolveApp(root, entry, params, overrides);
          const nodes = 'data' in state ? inspect(actor, state.data) : undefined;
          return Response.json({ ...state, nodes });
        } catch (err) {
          return Response.json({ failure: err instanceof Error ? err.message : String(err) }, { status: 400 });
        }
      },
    },
  },
});

console.log(`goblin inspector on ${server.url}`);
