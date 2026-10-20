/**
 * JSON-RPC 2.0 over HTTP: each `POST /` carries one CBOR or JSON message (request
 * or batch) and answers 200 with its response, or 204 when it was all notifications.
 * JSON-RPC failures are still 200s; HTTP statuses only reject the transport.
 */
import { type Codec, codecFor } from './codec';
import type { Format } from './dtos';
import { failure, type Methods, PARSE_ERROR, RpcServer } from './rpc';

/** Answers JSON-RPC `methods` posted to `/`, as a web-standard `fetch` handler. */
export class HttpServer {
  private readonly codec: Codec;
  private readonly rpc: RpcServer;

  constructor(methods: Methods, format: Format = 'cbor') {
    this.rpc = new RpcServer(methods);
    this.codec = codecFor(format);
  }

  fetch = async (req: Request): Promise<Response> => {
    const { contentType } = this.codec;
    if (new URL(req.url).pathname !== '/') return new Response('not found', { status: 404 });
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } });
    if (!req.headers.get('content-type')?.startsWith(contentType))
      return new Response(`expected content-type: ${contentType}`, { status: 415 });
    let message: unknown;
    try {
      message = this.codec.decode(new Uint8Array(await req.arrayBuffer()));
    } catch (err) {
      const reason = err instanceof Error ? err.message : err;
      return this.respond(failure(null, PARSE_ERROR, `invalid ${this.codec.name}: ${reason}`));
    }
    const answer = await this.rpc.handle(message);
    return answer === undefined ? new Response(null, { status: 204 }) : this.respond(answer);
  };

  private respond(answer: unknown): Response {
    return new Response(this.codec.encode(answer), { headers: { 'content-type': this.codec.contentType } });
  }
}
