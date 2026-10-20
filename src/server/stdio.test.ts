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

describe('StdioServer.serve --format json', () => {
  const server = new StdioServer({ echo: (params: unknown) => params }, 'json');
  const text = new TextEncoder();

  async function served(...parts: string[]): Promise<unknown[]> {
    const out: string[] = [];
    await server.serve(chunks(...parts.map((part) => text.encode(part))), (bytes) => {
      out.push(new TextDecoder().decode(bytes));
    });
    return out
      .join('')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
  }

  it('reads one message per line, across chunks and without a final newline', async () => {
    const line = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'echo', params: { n: id } });
    const first = line(1);
    expect(await served(first.slice(0, 5), `${first.slice(5)}\n\n${line(2)}\n`, line(3))).toEqual([
      { jsonrpc: '2.0', id: 1, result: { n: 1 } },
      { jsonrpc: '2.0', id: 2, result: { n: 2 } },
      { jsonrpc: '2.0', id: 3, result: { n: 3 } },
    ]);
  });

  it('reports a malformed line as a parse error and keeps reading', async () => {
    expect(await served(`{\n${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo' })}\n`)).toMatchObject([
      { id: null, error: { code: PARSE_ERROR } },
      { id: 1, result: null },
    ]);
  });
});
