/**
 * JSON-RPC 2.0 over stdio, each message (request, response or batch) one CBOR
 * item. CBOR items are self-delimiting, so the stream needs no other framing.
 */
import { Decoder, Encoder } from 'cbor-x';
import { RequestSchema } from './dtos';

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
/** Anything a method throws that is not a `StdioError`: the engine refused. */
export const SERVER_ERROR = -32000;

export class StdioError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type Id = string | number | null;

export type StdioResponse =
  | { jsonrpc: '2.0'; id: Id; result: unknown }
  | { jsonrpc: '2.0'; id: Id; error: { code: number; message: string } };

export type Methods = Record<string, (params: unknown) => unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const failure = (id: Id, code: number, message: string): StdioResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

/** Answers JSON-RPC `methods`, one request at a time and in order. */
export class StdioServer {
  private readonly decoder = new Decoder({ mapsAsObjects: true, useRecords: false });
  private readonly encoder = new Encoder({ mapsAsObjects: true, useRecords: false });

  constructor(private readonly methods: Methods) {}

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
        const answer = await this.handle(message);
        if (answer !== undefined) write(this.encoder.encode(answer));
      }
    }
    if (pending.length > 0) write(this.encoder.encode(failure(null, PARSE_ERROR, 'input ended mid-message')));
  }

  /** Answer one decoded message, a request or a batch of them; notifications get no answer. */
  async handle(message: unknown): Promise<StdioResponse | StdioResponse[] | undefined> {
    if (!Array.isArray(message)) return this.call(message);
    if (message.length === 0) return failure(null, INVALID_REQUEST, 'empty batch');
    const answers: StdioResponse[] = [];
    for (const request of message) {
      const answer = await this.call(request);
      if (answer !== undefined) answers.push(answer);
    }
    return answers.length > 0 ? answers : undefined;
  }

  private async call(request: unknown): Promise<StdioResponse | undefined> {
    const id =
      isRecord(request) && (typeof request.id === 'string' || typeof request.id === 'number') ? request.id : null;
    const parsed = RequestSchema.safeParse(request);
    if (!parsed.success) return failure(id, INVALID_REQUEST, 'expected { jsonrpc: "2.0", method, params?, id? }');
    const { method: name, params } = parsed.data;
    const notification = !('id' in parsed.data);
    const method = Object.hasOwn(this.methods, name) ? this.methods[name] : undefined;
    if (method === undefined)
      return notification ? undefined : failure(id, METHOD_NOT_FOUND, `no such method: ${name}`);
    try {
      // A JSON round trip keeps results to what the CLI would print (and hash): no undefined, no class instances.
      const result = JSON.parse(JSON.stringify((await method(params)) ?? null));
      return notification ? undefined : { jsonrpc: '2.0', id, result };
    } catch (err) {
      if (notification) return undefined;
      const message = err instanceof Error ? err.message : String(err);
      return failure(id, err instanceof StdioError ? err.code : SERVER_ERROR, message);
    }
  }
}
