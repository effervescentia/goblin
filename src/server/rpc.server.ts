/**
 * JSON-RPC 2.0 dispatch, shared by every transport: decoded messages in,
 * responses out. Framing and encoding belong to the transport.
 */
import { IdSchema, RequestSchema } from './dtos';

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
/** Anything a method throws that is not an `RpcError`: the engine refused. */
export const SERVER_ERROR = -32000;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type Id = string | number | null;

export type RpcResponse =
  | { jsonrpc: '2.0'; id: Id; result: unknown }
  | { jsonrpc: '2.0'; id: Id; error: { code: number; message: string } };

export type Methods = Record<string, (params: unknown) => unknown>;

export const failure = (id: Id, code: number, message: string): RpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

/** Answers JSON-RPC `methods`; a batch runs one request at a time and in order. */
export class RpcServer {
  constructor(private readonly methods: Methods) {}

  /** Answer one decoded message, a request or a batch of them; notifications get no answer. */
  async handle(message: unknown): Promise<RpcResponse | RpcResponse[] | undefined> {
    if (!Array.isArray(message)) return this.call(message);
    if (message.length === 0) return failure(null, INVALID_REQUEST, 'empty batch');
    const answers: RpcResponse[] = [];
    for (const request of message) {
      const answer = await this.call(request);
      if (answer !== undefined) answers.push(answer);
    }
    return answers.length > 0 ? answers : undefined;
  }

  private async call(request: unknown): Promise<RpcResponse | undefined> {
    const raw = IdSchema.safeParse(request);
    const id = raw.success ? (raw.data.id ?? null) : null;
    const parsed = RequestSchema.safeParse(request);
    if (!parsed.success) return failure(id, INVALID_REQUEST, 'expected { jsonrpc: "2.0", method, params?, id? }');

    const { method: name, params } = parsed.data;
    const notification = !('id' in parsed.data);
    const method = Object.hasOwn(this.methods, name) ? this.methods[name] : undefined;
    if (method === undefined) {
      return notification ? undefined : failure(id, METHOD_NOT_FOUND, `no such method: ${name}`);
    }

    try {
      // A JSON round trip keeps results to what the CLI would print (and hash): no undefined, no class instances.
      const result = JSON.parse(JSON.stringify((await method(params)) ?? null));
      return notification ? undefined : { jsonrpc: '2.0', id, result };
    } catch (err) {
      if (notification) return undefined;
      const message = err instanceof Error ? err.message : String(err);
      return failure(id, err instanceof RpcError ? err.code : SERVER_ERROR, message);
    }
  }
}
