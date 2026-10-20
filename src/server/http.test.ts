import { describe, expect, it } from 'vitest';
import { HttpServer } from './http';
import { PARSE_ERROR } from './rpc';

const server = new HttpServer({ echo: (params: unknown) => params });

const post = (body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  server.fetch(new Request('http://localhost/', { method: 'POST', headers, body }));

describe('HttpServer.fetch', () => {
  it('answers a posted request with its JSON response', async () => {
    const res = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { a: 1 } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { a: 1 } });
  });

  it('answers a batch in one response', async () => {
    const res = await post(
      JSON.stringify([
        { jsonrpc: '2.0', id: 'a', method: 'echo', params: [1] },
        { jsonrpc: '2.0', method: 'echo' },
      ]),
    );
    expect(await res.json()).toMatchObject([{ id: 'a', result: [1] }]);
  });

  it('answers 204 with no body when every message was a notification', async () => {
    const res = await post(JSON.stringify({ jsonrpc: '2.0', method: 'echo' }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('reports malformed JSON as a JSON-RPC parse error', async () => {
    const res = await post('{');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: null, error: { code: PARSE_ERROR } });
  });

  it('rejects other paths, methods and content types at the HTTP layer', async () => {
    expect((await server.fetch(new Request('http://localhost/other', { method: 'POST' }))).status).toBe(404);
    const get = await server.fetch(new Request('http://localhost/'));
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await post('{}', { 'content-type': 'text/plain' })).status).toBe(415);
  });
});
