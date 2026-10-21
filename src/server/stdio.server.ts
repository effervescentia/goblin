/**
 * JSON-RPC 2.0 over stdio, each message (request, response or batch) one CBOR
 * item, or one line of JSON. Either way the stream needs no other framing.
 */
import { type Codec, codecFor, concat } from './codec';
import type { Format } from './dtos';
import { failure, type Methods, PARSE_ERROR, RpcServer } from './rpc.server';

/** Answers JSON-RPC `methods` read from a byte stream, one message at a time and in order. */
export class StdioServer {
  private readonly codec: Codec;
  private readonly rpc: RpcServer;

  constructor(methods: Methods, format: Format = 'cbor') {
    this.rpc = new RpcServer(methods);
    this.codec = codecFor(format);
  }

  /** Serve requests from `input` until it ends. */
  async serve(input: AsyncIterable<Uint8Array>, write: (bytes: Uint8Array) => unknown): Promise<void> {
    let pending = new Uint8Array(0);
    for await (const chunk of input) {
      pending = await this.answer(concat(pending, chunk), false, write);
    }
    if (pending.length > 0) await this.answer(pending, true, write);
  }

  private async answer(pending: Uint8Array<ArrayBuffer>, final: boolean, write: (bytes: Uint8Array) => unknown) {
    const { frames, rest } = this.codec.frames(pending, final);
    for (const frame of frames) {
      const answer = 'error' in frame ? failure(null, PARSE_ERROR, frame.error) : await this.rpc.handle(frame.message);
      if (answer !== undefined) write(this.codec.encode(answer));
    }
    return rest;
  }
}
