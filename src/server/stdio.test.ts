import { decodeMultiple, encode } from 'cbor-x';
import { describe, expect, it } from 'vitest';
import { parseRunParams } from '../cli';
import { INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR, StdioError, StdioServer } from './stdio';

const server = new StdioServer({
  echo: (params: unknown) => params,
  fail: () => {
    throw new Error('nope');
  },
  reject: () => {
    throw new StdioError(INVALID_PARAMS, 'bad');
  },
});

async function* chunks(...parts: Uint8Array[]) {
  yield* parts;
}

async function served(...parts: Uint8Array[]): Promise<unknown[]> {
  const out: Uint8Array[] = [];
  await server.serve(chunks(...parts), (bytes) => out.push(bytes));
  return out.flatMap((bytes) => decodeMultiple(bytes) ?? []);
}

describe('StdioServer.handle', () => {
  it('answers a request with its result', async () => {
    expect(await server.handle({ jsonrpc: '2.0', id: 1, method: 'echo', params: { a: 1 } })).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { a: 1 },
    });
  });

  it('answers nothing to notifications, even failing ones', async () => {
    expect(await server.handle({ jsonrpc: '2.0', method: 'echo' })).toBeUndefined();
    expect(await server.handle({ jsonrpc: '2.0', method: 'fail' })).toBeUndefined();
    expect(await server.handle({ jsonrpc: '2.0', method: 'missing' })).toBeUndefined();
  });

  it('maps failures to JSON-RPC error codes', async () => {
    const error = async (request: unknown) =>
      ((await server.handle(request)) as { error: { code: number } }).error.code;
    expect(await error({ jsonrpc: '2.0', id: 1, method: 'missing' })).toBe(METHOD_NOT_FOUND);
    expect(await error({ jsonrpc: '2.0', id: 1, method: 'toString' })).toBe(METHOD_NOT_FOUND);
    expect(await error({ jsonrpc: '2.0', id: 1, method: 'fail' })).toBe(-32000);
    expect(await error({ jsonrpc: '2.0', id: 1, method: 'reject' })).toBe(INVALID_PARAMS);
    expect(await error({ id: 1, method: 'echo' })).toBe(INVALID_REQUEST);
    expect(await error({ jsonrpc: '2.0', id: {}, method: 'echo' })).toBe(INVALID_REQUEST);
    expect(await error([])).toBe(INVALID_REQUEST);
  });

  it('answers a batch in order, leaving out notifications', async () => {
    expect(
      await server.handle([
        { jsonrpc: '2.0', id: 'a', method: 'echo', params: [1] },
        { jsonrpc: '2.0', method: 'echo' },
        { jsonrpc: '2.0', id: 'b', method: 'missing' },
      ]),
    ).toMatchObject([
      { id: 'a', result: [1] },
      { id: 'b', error: { code: METHOD_NOT_FOUND } },
    ]);
    expect(await server.handle([{ jsonrpc: '2.0', method: 'echo' }])).toBeUndefined();
  });
});

describe('StdioServer.serve', () => {
  it('reads CBOR items across and within chunks', async () => {
    const first = encode({ jsonrpc: '2.0', id: 1, method: 'echo', params: { n: 1 } });
    const second = encode({ jsonrpc: '2.0', id: 2, method: 'echo', params: { n: 2 } });
    const third = encode({ jsonrpc: '2.0', id: 3, method: 'echo', params: { n: 3 } });
    const joined = new Uint8Array([...first.subarray(3), ...second]);
    expect(await served(first.subarray(0, 3), joined, third)).toEqual([
      { jsonrpc: '2.0', id: 1, result: { n: 1 } },
      { jsonrpc: '2.0', id: 2, result: { n: 2 } },
      { jsonrpc: '2.0', id: 3, result: { n: 3 } },
    ]);
  });

  it('reports malformed and truncated input as parse errors', async () => {
    expect(await served(new Uint8Array([0x1c]))).toMatchObject([{ id: null, error: { code: PARSE_ERROR } }]);
    const torn = encode({ jsonrpc: '2.0', id: 1, method: 'echo' });
    expect(await served(torn.subarray(0, 4))).toMatchObject([
      { id: null, error: { code: PARSE_ERROR, message: 'input ended mid-message' } },
    ]);
  });
});

describe('parseRunParams', () => {
  it('reads resolve params', () => {
    expect(parseRunParams()).toEqual({ inputs: [], stripMetadata: false });
    expect(
      parseRunParams({
        entry: 'a.yaml',
        in: { data: {} },
        inputs: [{ type: 'parameter', path: 'level', value: 3 }],
        stripMetadata: true,
      }),
    ).toEqual({
      entry: 'a.yaml',
      prior: { data: {} },
      inputs: [{ type: 'parameter', path: 'level', value: 3 }],
      stripMetadata: true,
    });
  });

  it('drops keys an input does not have, so they never reach the hashed events', () => {
    expect(parseRunParams({ inputs: [{ value: 3, path: 'level', type: 'parameter', version: 9 }] }).inputs).toEqual([
      { type: 'parameter', path: 'level', value: 3 },
    ]);
  });

  it('rejects malformed inputs and invokes the CLI would refuse', () => {
    expect(() => parseRunParams([])).toThrow('resolve expects');
    expect(() => parseRunParams({ entry: 1 })).toThrow('resolve expects');
    expect(() => parseRunParams({ inputs: [{ type: 'set', path: 'x', value: 1 }] })).toThrow('resolve expects');
    expect(() => parseRunParams({ inputs: [{ type: 'invoke', path: 'x', value: 1 }] })).toThrow('resolve expects');
    expect(() =>
      parseRunParams({
        inputs: [
          { type: 'invoke', path: 'x', value: [] },
          { type: 'invoke', path: 'y', value: [] },
        ],
      }),
    ).toThrow('one invoke');
    expect(() =>
      parseRunParams({
        inputs: [
          { type: 'override', path: 'x', value: 1 },
          { type: 'invoke', path: 'y', value: [] },
        ],
      }),
    ).toThrow('cannot be combined');
  });
});
