/**
 * JSON-RPC 2.0 over HTTP: each `POST /` carries one JSON message (request or
 * batch) and answers 200 with its response, or 204 when it was all notifications.
 * JSON-RPC failures are still 200s; HTTP statuses only reject the transport.
 */
import { failure, type Methods, PARSE_ERROR, RpcServer } from './rpc';

/** Answers JSON-RPC `methods` posted to `/`, as a web-standard `fetch` handler. */
export class HttpServer {
  private readonly rpc: RpcServer;

  constructor(methods: Methods) {
    this.rpc = new RpcServer(methods);
  }

  fetch = async (req: Request): Promise<Response> => {
    if (new URL(req.url).pathname !== '/') return new Response('not found', { status: 404 });
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } });
    if (!req.headers.get('content-type')?.startsWith('application/json'))
      return new Response('expected content-type: application/json', { status: 415 });
    let message: unknown;
    try {
      message = JSON.parse(await req.text());
    } catch (err) {
      return Response.json(failure(null, PARSE_ERROR, `invalid JSON: ${err instanceof Error ? err.message : err}`));
    }
    const answer = await this.rpc.handle(message);
    return answer === undefined ? new Response(null, { status: 204 }) : Response.json(answer);
  };
}
