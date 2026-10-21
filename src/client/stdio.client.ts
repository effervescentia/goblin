/**
 * JSON-RPC 2.0 over stdio: each message one CBOR item, or one line of JSON, on a
 * byte stream — a spawned `goblin --server stdio`'s pipes, or a given stream.
 */
import { type Codec, codecFor, concat } from '@/server/codec';
import type { Format } from '@/server/dtos';
import type { StdioOptions, Stream } from './dtos';
import { RpcClient } from './rpc.client';
import { exitError, spawnServer } from './spawn';

export class StdioClient extends RpcClient {
  private readonly reading: Promise<void>;
  private ending = false;

  private constructor(
    private readonly stream: Stream,
    private readonly codec: Codec,
  ) {
    super();
    this.reading = this.read();
  }

  static async open(options: StdioOptions, format: Format): Promise<StdioClient> {
    const codec = codecFor(format);
    if (options.stream) return new StdioClient(options.stream, codec);
    const server = await spawnServer(options.spawn ?? {}, 'stdio', format);
    const { child, exited, stderr } = server;
    // Output can end before the exit code is known; wait for it, so a crash says why.
    async function* readable() {
      yield* child.stdout;
      const code = await exited;
      if (code !== 0) throw exitError(code, stderr());
    }
    return new StdioClient(
      { readable: readable(), write: (bytes) => child.stdin.write(bytes), end: () => child.stdin.end() },
      codec,
    );
  }

  protected async send(message: unknown): Promise<void> {
    await this.stream.write(this.codec.encode(message));
  }

  protected async disconnect(): Promise<void> {
    this.ending = true;
    this.stream.end();
    await this.reading;
  }

  private async read(): Promise<void> {
    let pending = new Uint8Array(0);
    try {
      for await (const chunk of this.stream.readable) pending = this.take(concat(pending, chunk), false);
      if (pending.length > 0) this.take(pending, true);
      this.fail(new Error(this.ending ? 'client closed' : 'server closed the connection'));
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private take(pending: Uint8Array<ArrayBuffer>, final: boolean): Uint8Array<ArrayBuffer> {
    const { frames, rest } = this.codec.frames(pending, final);
    for (const frame of frames) {
      if ('error' in frame) this.fail(new Error(`server sent ${frame.error}`));
      else this.receive(frame.message);
    }
    return rest;
  }
}
