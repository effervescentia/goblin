/**
 * JSON-RPC 2.0 over WebSocket: each frame carries one message — binary CBOR, or
 * text JSON — on a socket opened to the server's `/`.
 */
import { type Codec, codecFor } from '@/server/codec';
import type { Format } from '@/server/dtos';
import type { WebSocketOptions } from './dtos';
import { RpcClient } from './rpc.client';
import { listening, type Server, spawnServer, stop } from './spawn';

export class WebSocketClient extends RpcClient {
  private readonly closed: Promise<void>;

  private constructor(
    private readonly ws: WebSocket,
    private readonly codec: Codec,
    private readonly server?: Server,
  ) {
    super();
    const text = new TextEncoder();
    ws.onmessage = ({ data }) => {
      try {
        this.receive(codec.decode(typeof data === 'string' ? text.encode(data) : new Uint8Array(data)));
      } catch (err) {
        this.fail(new Error(`server sent invalid ${codec.name}: ${err instanceof Error ? err.message : err}`));
      }
    };
    this.closed = new Promise((resolve) => {
      ws.onclose = ({ code, reason }) => {
        this.fail(new Error(`socket closed (${code})${reason === '' ? '' : `: ${reason}`}`));
        resolve();
      };
    });
  }

  static async open(options: WebSocketOptions, format: Format): Promise<WebSocketClient> {
    const codec = codecFor(format);
    if (options.url !== undefined) return new WebSocketClient(await connect(options.url), codec);
    const server = await spawnServer(options.spawn, 'websocket', format, options.port ?? 0);
    try {
      return new WebSocketClient(await connect(await listening(server)), codec, server);
    } catch (err) {
      await stop(server);
      throw err;
    }
  }

  protected send(message: unknown): void {
    this.ws.send(this.codec.frame(message));
  }

  protected async disconnect(): Promise<void> {
    this.ws.close();
    await this.closed;
    if (this.server) await stop(this.server);
  }
}

function connect(url: string | URL): Promise<WebSocket> {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`could not connect to ${url}`));
  });
}
