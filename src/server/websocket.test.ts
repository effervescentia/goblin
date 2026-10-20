import { decode, encode } from 'cbor-x';
import { describe, expect, it } from 'vitest';
import { PARSE_ERROR } from './rpc';
import { UNSUPPORTED_DATA, WebSocketServer } from './websocket';

const methods = {
  echo: (params: unknown) => params,
  slow: async (params: unknown) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return params;
  },
};

class FakeSocket {
  readonly sent: (string | Uint8Array)[] = [];
  closed?: { code?: number; reason?: string };

  send(data: string | Uint8Array) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
}

describe('WebSocketServer.fetch', () => {
  const server = new WebSocketServer(methods);
  const upgrading = { upgrade: () => true };
  const refusing = { upgrade: () => false };

  it('upgrades requests to /, leaving the response to the upgrade', () => {
    expect(server.fetch(new Request('http://localhost/'), upgrading)).toBeUndefined();
    const local = new Request('http://localhost/', { headers: { origin: 'http://localhost:3000' } });
    expect(server.fetch(local, upgrading)).toBeUndefined();
  });

  it('answers 426 to a request that is not an upgrade, and 404 off /', () => {
    const res = server.fetch(new Request('http://localhost/'), refusing);
    expect(res?.status).toBe(426);
    expect(res?.headers.get('upgrade')).toBe('websocket');
    expect(server.fetch(new Request('http://localhost/other'), upgrading)?.status).toBe(404);
  });

  it('refuses pages from other origins', () => {
    for (const origin of ['https://evil.example', 'null']) {
      const req = new Request('http://localhost/', { headers: { origin } });
      expect(server.fetch(req, upgrading)?.status).toBe(403);
    }
  });
});

describe('WebSocketServer.websocket over CBOR (the default)', () => {
  const server = new WebSocketServer(methods);

  it('answers each binary frame with one, in order', async () => {
    const ws = new FakeSocket();
    const slow = server.websocket.message(ws, encode({ jsonrpc: '2.0', id: 1, method: 'slow', params: [1] }));
    await server.websocket.message(ws, encode({ jsonrpc: '2.0', id: 2, method: 'echo', params: [2] }));
    await slow;
    expect(ws.sent.map((frame) => decode(frame as Uint8Array))).toEqual([
      { jsonrpc: '2.0', id: 1, result: [1] },
      { jsonrpc: '2.0', id: 2, result: [2] },
    ]);
  });

  it('sends nothing for notifications, and a parse error for malformed CBOR', async () => {
    const ws = new FakeSocket();
    await server.websocket.message(ws, encode({ jsonrpc: '2.0', method: 'echo' }));
    await server.websocket.message(ws, new Uint8Array([0x1c]));
    expect(ws.sent.map((frame) => decode(frame as Uint8Array))).toMatchObject([
      { id: null, error: { code: PARSE_ERROR } },
    ]);
  });

  it('closes on a text frame', async () => {
    const ws = new FakeSocket();
    await server.websocket.message(ws, '{}');
    expect(ws.closed).toEqual({ code: UNSUPPORTED_DATA, reason: 'expected binary CBOR frames' });
    expect(ws.sent).toEqual([]);
  });
});

describe('WebSocketServer.websocket --format json', () => {
  const server = new WebSocketServer(methods, 'json');

  it('answers each text frame with one', async () => {
    const ws = new FakeSocket();
    await server.websocket.message(ws, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { a: 1 } }));
    await server.websocket.message(ws, '{');
    expect(ws.sent.map((frame) => JSON.parse(frame as string))).toMatchObject([
      { jsonrpc: '2.0', id: 1, result: { a: 1 } },
      { id: null, error: { code: PARSE_ERROR } },
    ]);
  });

  it('closes on a binary frame', async () => {
    const ws = new FakeSocket();
    await server.websocket.message(ws, new TextEncoder().encode('{}'));
    expect(ws.closed).toEqual({ code: UNSUPPORTED_DATA, reason: 'expected text JSON frames' });
  });
});
