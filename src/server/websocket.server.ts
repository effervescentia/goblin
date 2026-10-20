/**
 * JSON-RPC 2.0 over WebSocket: clients upgrade at `/`, then each frame carries one
 * message (request, response or batch) — binary CBOR, or text JSON. Frames delimit
 * themselves, so nothing else frames the stream.
 */
import { type Codec, codecFor } from './codec';
import type { Format } from './dtos';
import { failure, type Methods, PARSE_ERROR, RpcServer } from './rpc.server';

/** The slice of a server WebSocket this transport uses (Bun's `ServerWebSocket` fits). */
export interface Socket {
  send(data: string | Uint8Array<ArrayBuffer>): unknown;
  close(code?: number, reason?: string): unknown;
}

/** The slice of a server that can take over a request's connection (Bun's `Server` fits). */
export interface Upgrader {
  upgrade(req: Request): boolean;
}

/** RFC 6455: the endpoint got a kind of data it cannot accept. */
export const UNSUPPORTED_DATA = 1003;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Answers JSON-RPC `methods` sent over WebSockets, each socket's messages one at a time and in order. */
export class WebSocketServer {
  private readonly codec: Codec;
  private readonly rpc: RpcServer;
  private readonly queues = new WeakMap<Socket, Promise<void>>();

  constructor(methods: Methods, format: Format = 'cbor') {
    this.rpc = new RpcServer(methods);
    this.codec = codecFor(format);
  }

  fetch = (req: Request, server: Upgrader): Response | undefined => {
    if (new URL(req.url).pathname !== '/') return new Response('not found', { status: 404 });
    // Browsers let any page open a socket to localhost; only a loopback page (or a non-browser client) may.
    const origin = req.headers.get('origin');
    if (origin !== null && !LOOPBACK.has(URL.parse(origin)?.hostname ?? ''))
      return new Response('forbidden origin', { status: 403 });
    if (server.upgrade(req)) return undefined;
    return new Response('expected a WebSocket upgrade', { status: 426, headers: { upgrade: 'websocket' } });
  };

  /** The handlers to pass as `Bun.serve({ websocket })`. */
  readonly websocket = {
    message: (ws: Socket, data: string | Uint8Array) => {
      const queued = (this.queues.get(ws) ?? Promise.resolve()).then(() => this.answer(ws, data));
      this.queues.set(ws, queued);
      return queued;
    },
  };

  private async answer(ws: Socket, data: string | Uint8Array) {
    const { codec } = this;
    if (codec.text !== (typeof data === 'string')) {
      ws.close(UNSUPPORTED_DATA, `expected ${codec.text ? 'text' : 'binary'} ${codec.name} frames`);
      return;
    }
    let message: unknown;
    try {
      message = codec.decode(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    } catch (err) {
      const reason = err instanceof Error ? err.message : err;
      ws.send(codec.frame(failure(null, PARSE_ERROR, `invalid ${codec.name}: ${reason}`)));
      return;
    }
    const answer = await this.rpc.handle(message);
    if (answer !== undefined) ws.send(codec.frame(answer));
  }
}
