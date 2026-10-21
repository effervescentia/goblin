/**
 * Goblin client — talks JSON-RPC 2.0 to a `goblin --server`, over stdio, HTTP or
 * WebSocket, by connecting to a running one or spawning its own.
 *
 *   const client = await createClient({ transport: 'websocket', url: 'ws://127.0.0.1:7357' });
 *   const turn = await client.resolve({ entry: 'sheet.yaml' });
 *   await client.close();
 */
import { match } from 'ts-pattern';
import type { ClientOptions } from './dtos';
import { HttpClient } from './http.client';
import type { RpcClient } from './rpc.client';
import { StdioClient } from './stdio.client';
import { WebSocketClient } from './websocket.client';

/** Open a client of any transport; `close` it to release the connection and stop any server it spawned. */
export function createClient(options: ClientOptions): Promise<RpcClient> {
  const format = options.format ?? 'cbor';
  return match(options)
    .with({ transport: 'stdio' }, (stdio) => StdioClient.open(stdio, format))
    .with({ transport: 'http' }, (http) => HttpClient.open(http, format))
    .with({ transport: 'websocket' }, (websocket) => WebSocketClient.open(websocket, format))
    .exhaustive();
}
