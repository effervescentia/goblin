import { describe, expect, it } from 'vitest';
import { RpcError } from '@/errors';
import type { Format } from '@/server/dtos';
import { HttpServer } from '@/server/http.server';
import { failure, METHOD_NOT_FOUND, type Methods, PARSE_ERROR, SERVER_ERROR } from '@/server/rpc.server';
import { StdioServer } from '@/server/stdio.server';
import { createClient } from './client';
import type { Stream } from './dtos';
import { RpcClient } from './rpc.client';

const methods: Methods = {
  echo: (params) => params,
  slow: async (params) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return params;
  },
  resolve: (params) => ({ resolved: params }),
  fail: () => {
    throw new Error('nope');
  },
};

async function* drain(readable: ReadableStream<Uint8Array>) {
  const reader = readable.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) yield read.value;
}

/** A stdio server running in-process, its pipes as a client `Stream`. */
function piped(format: Format): Stream {
  const toServer = new TransformStream<Uint8Array, Uint8Array>();
  const fromServer = new TransformStream<Uint8Array, Uint8Array>();
  const input = toServer.writable.getWriter();
  const output = fromServer.writable.getWriter();
  void new StdioServer(methods, format)
    .serve(drain(toServer.readable), (bytes) => output.write(bytes))
    .then(() => output.close());
  return { readable: drain(fromServer.readable), write: (bytes) => input.write(bytes), end: () => input.close() };
}

const FORMATS: Format[] = ['cbor', 'json'];

describe.each(FORMATS)('createClient over %s', (format) => {
  const transports = {
    stdio: () => createClient({ transport: 'stdio', format, stream: piped(format) }),
    http: () => {
      const server = new HttpServer(methods, format);
      const post = (url: string | URL | Request, init?: RequestInit) => server.fetch(new Request(url, init));
      return createClient({ transport: 'http', format, url: 'http://localhost/', fetch: post as typeof fetch });
    },
  };

  describe.each(Object.entries(transports))('%s', (_, open) => {
    it('answers calls with their results, and resolve with its envelope', async () => {
      const client = await open();
      expect(await Promise.all([client.call('slow', [1]), client.call('echo', { a: 1 })])).toEqual([[1], { a: 1 }]);
      expect(await client.resolve({ entry: 'a.yaml' })).toEqual({ resolved: { entry: 'a.yaml' } });
      await client.notify('echo');
      await client.close();
    });

    it('rejects a failing call with its JSON-RPC code, and keeps going', async () => {
      const client = await open();
      await expect(client.call('fail')).rejects.toMatchObject({ code: SERVER_ERROR, message: 'nope' });
      const missing = (await client.call('missing').catch((err) => err)) as RpcError;
      expect(missing).toBeInstanceOf(RpcError);
      expect(missing.code).toBe(METHOD_NOT_FOUND);
      expect(await client.call('echo', [2])).toEqual([2]);
      await client.close();
    });

    it('lets in-flight calls answer on close, then refuses more', async () => {
      const client = await open();
      const slow = client.call('slow', ['late']);
      await client.close();
      expect(await slow).toEqual(['late']);
      await expect(client.call('echo')).rejects.toThrow('client closed');
    });
  });
});

describe('createClient stdio over a stream', () => {
  it('fails every call once the server closes its output', async () => {
    const stream: Stream = { readable: (async function* () {})(), write: () => {}, end: () => {} };
    const client = await createClient({ transport: 'stdio', stream });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(client.call('echo')).rejects.toThrow('server closed the connection');
  });
});

describe('createClient http', () => {
  it('rejects a call the server refuses at the HTTP layer', async () => {
    const refusing = (async () => new Response('nope', { status: 415 })) as unknown as typeof fetch;
    const client = await createClient({ transport: 'http', url: 'http://localhost/', fetch: refusing });
    await expect(client.call('echo')).rejects.toThrow('HTTP 415: nope');
  });
});

/** Answers whatever `respond` makes of the requests sent so far. */
class ScriptedClient extends RpcClient {
  readonly sent: { id?: number }[] = [];

  protected send(message: unknown) {
    this.sent.push(message as { id?: number });
  }

  protected async disconnect() {}

  answer(message: unknown) {
    this.receive(message);
  }
}

describe('RpcClient', () => {
  it('matches responses to calls by id, in any order and across a batch', async () => {
    const client = new ScriptedClient();
    const first = client.call('a');
    const second = client.call('b');
    await Promise.resolve();
    const [a, b] = client.sent.map((request) => request.id);
    client.answer([
      { jsonrpc: '2.0', id: b, result: 'b' },
      { jsonrpc: '2.0', id: 99, result: 'stray' },
      { jsonrpc: '2.0', id: a, result: 'a' },
    ]);
    expect(await Promise.all([first, second])).toEqual(['a', 'b']);
  });

  it('fails every call when the server could not read a message', async () => {
    const client = new ScriptedClient();
    const calls = [client.call('a'), client.call('b')].map((call) => call.catch((err) => err));
    client.answer(failure(null, PARSE_ERROR, 'invalid CBOR'));
    for (const err of await Promise.all(calls)) expect(err).toMatchObject({ code: PARSE_ERROR });
    await expect(client.call('c')).rejects.toMatchObject({ code: PARSE_ERROR });
  });

  it('fails on anything that is not a response', async () => {
    const client = new ScriptedClient();
    const call = client.call('a');
    client.answer({ hello: 'world' });
    await expect(call).rejects.toThrow('other than a JSON-RPC response');
  });
});
