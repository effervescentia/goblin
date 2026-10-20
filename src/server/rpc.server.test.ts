import { describe, expect, it } from 'vitest';
import { parseRunParams } from '@/cli/cli';
import { INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, RpcError, RpcServer } from './rpc.server';

const server = new RpcServer({
  echo: (params: unknown) => params,
  fail: () => {
    throw new Error('nope');
  },
  reject: () => {
    throw new RpcError(INVALID_PARAMS, 'bad');
  },
});

describe('RpcServer.handle', () => {
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
    expect(await error({ jsonrpc: '2.0', id: 1, method: 'echo', params: 'x' })).toBe(INVALID_REQUEST);
    expect(await error({ jsonrpc: '2.0', id: undefined, method: 'echo' })).toBe(INVALID_REQUEST);
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
