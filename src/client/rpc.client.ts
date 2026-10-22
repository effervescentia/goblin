/**
 * JSON-RPC 2.0 calls, shared by every transport: requests out, responses matched
 * back to their callers by id. Framing and encoding belong to the transport.
 */
import { RpcError } from '@/errors';
import type { ActorExport } from '@/inputs';
import type { InspectNode } from '@/inspect';
import {
  type Answer,
  type ExportParams,
  type ImportParams,
  type InspectParams,
  type ResolveParams,
  ResponseSchema,
  type Rewound,
} from './dtos';

interface Waiting {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

/** A connection to a goblin `--server`; responses may arrive in any order. */
export abstract class RpcClient {
  private next = 0;
  private readonly pending = new Map<number, Waiting>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private failure?: Error;

  /** Hand one encoded message to the server. */
  protected abstract send(message: unknown): Promise<void> | void;

  /** Release the transport; every call has been answered by now. */
  protected abstract disconnect(): Promise<void>;

  /** Resolve a turn: the same envelope (and `hash`) a one-shot CLI run prints, plus a stateful server's session keys. */
  resolve(params: ResolveParams = {}): Promise<Answer> {
    return this.call('resolve', params) as Promise<Answer>;
  }

  /** Every field of the resolved state, with the expression behind it and what it reads; empty while it asks. */
  inspect(params: InspectParams = {}): Promise<InspectNode[]> {
    return this.call('inspect', params) as Promise<InspectNode[]>;
  }

  /** One actor's state as a `set` per node, for `import` into a session built from the same files. */
  export(params: ExportParams): Promise<ActorExport> {
    return this.call('export', params) as Promise<ActorExport>;
  }

  /** Import an `export` answer into the actor at `path` as one turn, answering like `resolve`. */
  import(params: ImportParams): Promise<Answer> {
    return this.call('import', params) as Promise<Answer>;
  }

  /** Cut a stateful server's session back to `version`, so the next `resolve` continues from it. */
  rewind(version: number): Promise<Rewound> {
    return this.call('rewind', { version }) as Promise<Rewound>;
  }

  call(method: string, params?: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.next;
    const answer = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Async so a throwing send rejects the call, yet it starts now: a `close` right after must not overtake it.
      (async () => this.send(request(method, params, id)))().catch((err) => {
        this.pending.delete(id);
        reject(err);
      });
    });
    this.inFlight.add(answer);
    const done = () => this.inFlight.delete(answer);
    answer.then(done, done);
    return answer;
  }

  /** Call `method` without asking for an answer; the server reports nothing back, not even failures. */
  async notify(method: string, params?: unknown): Promise<void> {
    if (this.failure) throw this.failure;
    await this.send(request(method, params));
  }

  /** Wait out the calls in flight, then release the transport; later calls reject. */
  async close(): Promise<void> {
    if (this.failure) return;
    await Promise.allSettled(this.inFlight);
    await this.disconnect();
    this.fail(new Error('client closed'));
  }

  /** Settle the calls one decoded message (a response or batch) answers. */
  protected receive(message: unknown): void {
    for (const response of Array.isArray(message) ? message : [message]) {
      const parsed = ResponseSchema.safeParse(response);
      if (!parsed.success) {
        this.fail(new Error('server sent something other than a JSON-RPC response'));
        return;
      }
      const answer = parsed.data;
      // A null id answers a message the server could not read, so it cannot say whose it was.
      if (answer.id === null && 'error' in answer) {
        this.fail(new RpcError(answer.error.code, answer.error.message));
        return;
      }
      const waiting = typeof answer.id === 'number' ? this.pending.get(answer.id) : undefined;
      if (waiting === undefined) continue;
      this.pending.delete(answer.id as number);
      if ('error' in answer) waiting.reject(new RpcError(answer.error.code, answer.error.message));
      else waiting.resolve(answer.result);
    }
  }

  /** Reject every call in flight, and every one after, with the first reason the connection broke. */
  protected fail(err: Error): void {
    this.failure ??= err;
    for (const { reject } of this.pending.values()) reject(this.failure);
    this.pending.clear();
  }
}

const request = (method: string, params: unknown, id?: number) => ({
  jsonrpc: '2.0',
  ...(id === undefined ? {} : { id }),
  method,
  ...(params === undefined ? {} : { params }),
});
