/**
 * JSON-RPC 2.0 over HTTP: each message is one `POST` to the server's `/`, its
 * answer the response body (none for notifications).
 */
import { type Codec, codecFor } from '@/server/codec';
import type { Format } from '@/server/dtos';
import type { HttpOptions } from './dtos';
import { RpcClient } from './rpc.client';
import { listening, type Server, spawnServer, stop } from './spawn';

export class HttpClient extends RpcClient {
  private constructor(
    private readonly url: URL,
    private readonly codec: Codec,
    private readonly post: typeof fetch,
    private readonly server?: Server,
  ) {
    super();
  }

  static async open(options: HttpOptions, format: Format): Promise<HttpClient> {
    const codec = codecFor(format);
    const post = options.fetch ?? fetch;
    if (options.url !== undefined) return new HttpClient(new URL(options.url), codec, post);
    const server = await spawnServer(options.spawn, 'http', format, options.port ?? 0);
    try {
      return new HttpClient(new URL(await listening(server)), codec, post, server);
    } catch (err) {
      await stop(server);
      throw err;
    }
  }

  protected async send(message: unknown): Promise<void> {
    const { contentType } = this.codec;
    const res = await this.post(this.url, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: this.codec.encode(message),
    });
    if (res.status === 204) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    this.receive(this.codec.decode(new Uint8Array(await res.arrayBuffer())));
  }

  protected async disconnect(): Promise<void> {
    if (this.server) await stop(this.server);
  }
}
