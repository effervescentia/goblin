import { decodeMultiple, encode } from 'cbor-x';
import { describe, expect, it } from 'vitest';
import { PARSE_ERROR } from './rpc';
import { StdioServer } from './stdio';

const server = new StdioServer({ echo: (params: unknown) => params });

async function* chunks(...parts: Uint8Array[]) {
  yield* parts;
}

async function served(...parts: Uint8Array[]): Promise<unknown[]> {
  const out: Uint8Array[] = [];
  await server.serve(chunks(...parts), (bytes) => out.push(bytes));
  return out.flatMap((bytes) => decodeMultiple(bytes) ?? []);
}

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
