/**
 * Goblin inspector server (Bun-only): serves the UI and resolves entries
 * through the same path as the CLI, adding the flattened node list.
 *
 *   bun run ui            # http://localhost:3000
 */
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
