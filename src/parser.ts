const WHITESPACE = /\s/;
const NON_WHITESPACE = /\S/;

export class Parser {
  public static parseIf(predicate: (char: string) => boolean) {
    return (parser: Parser): [null, Parser] | null => {
      if (!parser.buffer) return null;

      const next = parser.read();
      if (predicate(next)) return null;

      return [null, parser];
    };
  }

  public static parseChar(char: string) {
    return this.parseIf((next) => next !== char);
  }

  public static parseUntil(shouldStop: (char: string) => boolean) {
    return (parser: Parser): [string, Parser] | null => {
      let token = '';

      while (true) {
        const char = parser.peek();
        if (shouldStop(char)) break;
        token += char;
        parser.dump();
      }

      if (!token) return null;

      parser.skipWhitespace();

      return [token, parser];
    };
  }

  public static parseToken = this.parseUntil(
    (char) => !char.match(NON_WHITESPACE),
  );

  private buffer: string;

  constructor(private input: string) {
    this.buffer = input.trim();
  }

  private clone(): Parser {
    const clone = new Parser(this.input);
    clone.buffer = this.buffer;
    return clone;
  }

  public peek(): string {
    if (!this.buffer) return '';

    return this.buffer[0];
  }

  public dump() {
    this.buffer = this.buffer.slice(1);
  }

  public read() {
    const char = this.peek();
    this.dump();
    return char;
  }

  public skipWhitespace() {
    if (!this.buffer) return;

    while (true) {
      const char = this.peek();
      if (!char.match(WHITESPACE)) break;
      this.dump();
    }
  }

  public parse<T>(
    parsers: Array<(parser: Parser) => [T, Parser] | null>,
  ): T | null {
    if (!this.buffer) return null;

    let curr;
    for (const parser of parsers) {
      const next = parser(this.clone());
      if (!next) continue;
      // find the one that has parsed the most
      if (next[1].buffer.length >= (curr?.[1].buffer.length ?? Infinity))
        continue;

      curr = next;
    }

    if (!curr) return null;

    this.buffer = curr[1].buffer;

    return curr[0];
  }

  public parseCompletely<T>(
    parsers: Array<(parser: Parser) => [T, Parser] | null>,
  ): T[] {
    const tokens = [];
    while (true) {
      const token = this.parse(parsers);
      if (!token) break;

      tokens.push(token);
    }

    console.log(tokens);

    return tokens;
  }
}
