import z from 'zod';
import type { ResolveParamsSchema } from '@/cli/dtos';
import type { StateEvent } from '@/inputs';
import type { MissingParam } from '@/nodes/record';
import type { Format } from '@/server/dtos';
import type { Turn } from '@/server/session';

export const ResponseSchema = z
  .object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number(), z.null()]) })
  .and(
    z.union([
      z.object({ error: z.object({ code: z.number(), message: z.string() }) }),
      z.object({ result: z.unknown() }),
    ]),
  );

/** The `resolve` params, as `--server` reads them. */
export type ResolveParams = z.input<typeof ResolveParamsSchema>;

/** The envelope a one-shot CLI run prints. */
type Envelope =
  | { hash: string; version: number; events: StateEvent[]; result?: unknown; data: unknown }
  | { hash: string; version: number; events: StateEvent[]; query: MissingParam[] }
  | { errors: string[] };

/** What `resolve` answers: the envelope, plus the session keys unless the server is `--stateless`. */
export type Answer = Envelope & Partial<Turn>;

/** How to start a `goblin --server`; the client adds `--server`, `--format` and `--port` itself. */
export interface Spawn {
  /** The goblin binary, or a runtime to run `args` with (`bun`). */
  command?: string;
  /** Arguments ahead of the server flags, e.g. `['src/cli/cli.ts']`. */
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** A byte stream to a stdio server that is already running. */
export interface Stream {
  readable: AsyncIterable<Uint8Array>;
  write(bytes: Uint8Array): unknown;
  /** End the server's input: it answers what it has read, then closes `readable`. */
  end(): unknown;
}

interface Common {
  /** The server's wire format; CBOR unless given, like `--format`. */
  format?: Format;
}

export type StdioOptions = Common & { transport: 'stdio' } & (
    | { spawn?: Spawn; stream?: never }
    | { stream: Stream; spawn?: never }
  );

/** Connect to a running server at `url`, or `spawn` one on `port` (0, the default, lets the OS pick). */
type Remote = { url: string | URL; spawn?: never; port?: never } | { spawn: Spawn; port?: number; url?: never };

export type HttpOptions = Common & { transport: 'http'; fetch?: typeof fetch } & Remote;

export type WebSocketOptions = Common & { transport: 'websocket' } & Remote;

export type ClientOptions = StdioOptions | HttpOptions | WebSocketOptions;
