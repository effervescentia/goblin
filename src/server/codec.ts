/**
 * Wire formats for `--server`: how a transport turns bytes into messages and back.
 * CBOR items are self-delimiting on a stream; JSON is one message per line there.
 */
import { Decoder, Encoder } from 'cbor-x';
import type { Format } from './dtos';

/** One message pulled off a stream, or why its bytes could not be read. */
export type Frame = { message: unknown } | { error: string };

export interface Codec {
  readonly name: string;
  readonly contentType: string;
  encode(message: unknown): Uint8Array<ArrayBuffer>;
  /** Decode one whole message (an HTTP body); throws on malformed input. */
  decode(bytes: Uint8Array): unknown;
  /** Read every whole message off a stream buffer, returning the torn tail to wait on; `final` when no more bytes come. */
  frames(pending: Uint8Array<ArrayBuffer>, final: boolean): { frames: Frame[]; rest: Uint8Array<ArrayBuffer> };
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

const EMPTY = new Uint8Array(0);

class CborCodec implements Codec {
  readonly name = 'CBOR';
  readonly contentType = 'application/cbor';
  private readonly decoder = new Decoder({ mapsAsObjects: true, useRecords: false });
  private readonly encoder = new Encoder({ mapsAsObjects: true, useRecords: false });

  encode(message: unknown): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.encoder.encode(message));
  }

  decode(bytes: Uint8Array): unknown {
    return this.decoder.decode(bytes);
  }

  frames(pending: Uint8Array<ArrayBuffer>, final: boolean): { frames: Frame[]; rest: Uint8Array<ArrayBuffer> } {
    const frames: Frame[] = [];
    try {
      this.decoder.decodeMultiple(pending, (message) => {
        frames.push({ message });
      });
      return { frames, rest: EMPTY };
    } catch (err) {
      const partial = err as { incomplete?: boolean; lastPosition?: number };
      // A torn item waits for the rest; a malformed one leaves no way to resync, so drop what is buffered.
      if (!partial.incomplete) return { frames: [...frames, { error: `invalid CBOR: ${reason(err)}` }], rest: EMPTY };
      if (final) return { frames: [...frames, { error: 'input ended mid-message' }], rest: EMPTY };
      return { frames, rest: pending.slice(partial.lastPosition ?? 0) };
    }
  }
}

const NEWLINE = 0x0a;

class JsonCodec implements Codec {
  readonly name = 'JSON';
  readonly contentType = 'application/json';
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  encode(message: unknown): Uint8Array<ArrayBuffer> {
    return this.encoder.encode(`${JSON.stringify(message)}\n`);
  }

  decode(bytes: Uint8Array): unknown {
    return JSON.parse(this.decoder.decode(bytes));
  }

  // A bad line costs only itself: the next newline resyncs. A last line needs no newline.
  frames(pending: Uint8Array<ArrayBuffer>, final: boolean): { frames: Frame[]; rest: Uint8Array<ArrayBuffer> } {
    const frames: Frame[] = [];
    let start = 0;
    for (let end = pending.indexOf(NEWLINE); end !== -1 || (final && start < pending.length); ) {
      const stop = end === -1 ? pending.length : end;
      const line = this.decoder.decode(pending.subarray(start, stop));
      if (line.trim() !== '') {
        try {
          frames.push({ message: JSON.parse(line) });
        } catch (err) {
          frames.push({ error: `invalid JSON: ${reason(err)}` });
        }
      }
      start = stop + 1;
      end = pending.indexOf(NEWLINE, start);
    }
    return { frames, rest: start >= pending.length ? EMPTY : pending.slice(start) };
  }
}

export const codecFor = (format: Format): Codec => (format === 'cbor' ? new CborCodec() : new JsonCodec());
