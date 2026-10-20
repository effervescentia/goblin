/**
 * JSON-RPC 2.0 over stdio, each message (request, response or batch) one CBOR
 * item. CBOR items are self-delimiting, so the stream needs no other framing.
 */
import { Decoder, Encoder } from 'cbor-x';
import { failure, type Methods, PARSE_ERROR, RpcServer } from './rpc';

/** Answers JSON-RPC `methods` read from a byte stream, one message at a time and in order. */
export class StdioServer {
  private readonly decoder = new Decoder({ mapsAsObjects: true, useRecords: false });
  private readonly encoder = new Encoder({ mapsAsObjects: true, useRecords: false });
  private readonly rpc: RpcServer;

  constructor(methods: Methods) {
    this.rpc = new RpcServer(methods);
  }

  /** Serve requests from `input` until it ends. */
  async serve(input: AsyncIterable<Uint8Array>, write: (bytes: Uint8Array) => unknown): Promise<void> {
    let pending = new Uint8Array(0);
    for await (const chunk of input) {
      const joined = new Uint8Array(pending.length + chunk.length);
      joined.set(pending);
      joined.set(chunk, pending.length);
      pending = joined;
      const messages: unknown[] = [];
      try {
        this.decoder.decodeMultiple(pending, (message) => {
          messages.push(message);
        });
        pending = new Uint8Array(0);
      } catch (err) {
        const partial = err as { incomplete?: boolean; lastPosition?: number };
        // A torn item waits for the rest; a malformed one leaves no way to resync, so drop what is buffered.
        if (partial.incomplete) pending = pending.slice(partial.lastPosition ?? 0);
        else {
          pending = new Uint8Array(0);
          write(
            this.encoder.encode(
              failure(null, PARSE_ERROR, `invalid CBOR: ${err instanceof Error ? err.message : err}`),
            ),
          );
        }
      }
      for (const message of messages) {
        const answer = await this.rpc.handle(message);
        if (answer !== undefined) write(this.encoder.encode(answer));
      }
    }
    if (pending.length > 0) write(this.encoder.encode(failure(null, PARSE_ERROR, 'input ended mid-message')));
  }
}
