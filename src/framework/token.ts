/** biome-ignore-all lint/style/noNonNullAssertion: expected */
import { Die, DieRoll } from './die';

export abstract class Token {
  private static readonly SPACE = ' ';
  private static readonly NEWLINE = '\n';

  private static get CHARACTERS(): Array<{ new (): Token; CHARACTER: string }> {
    return [
      ColonToken,
      AtSignToken,
      PeriodToken,
      CommaToken,
      ExclamationMarkToken,
      DollarSignToken,
      PlusSignToken,
      MinusSignToken,
      EqualSignToken,
      AsteriskToken,
      TildeToken,
      OctothorpeToken,
      OpenParenthesisToken,
      CloseParenthesisToken,
      ForwardSlashToken,
    ];
  }

  private static get SEQUENCES(): Array<ReturnType<typeof SequenceToken>> {
    return [DieRollToken, StringToken];
  }

  private static get PATTERNS(): Array<ReturnType<typeof PatternToken>> {
    return [DigitsToken, WordToken];
  }

  private static reduceSequences(
    sequences: Array<ReturnType<typeof SequenceToken>>,
    phrase: string,
  ): Array<InstanceType<ReturnType<typeof SequenceToken>>> {
    return sequences.flatMap((sequence) => {
      const match = sequence.match(phrase);
      return match ? new sequence(match) : [];
    });
  }

  private static reducePatterns(
    patterns: Array<ReturnType<typeof PatternToken>>,
    phrase: string,
  ): Array<InstanceType<ReturnType<typeof PatternToken>>> {
    return patterns.flatMap((pattern) => (pattern.match(phrase) ? new pattern(phrase) : []));
  }

  public static tokenize(text: string) {
    const process = (input: string): Token[] => {
      if (!input.length) return [];

      const char = input[0]!;
      const next = input.substring(1);

      if (char === Token.SPACE || char === Token.NEWLINE) return process(next);

      for (const token of Token.CHARACTERS) {
        if (char === token.CHARACTER) {
          return [new token(), ...process(next)];
        }
      }

      const [sequence] = Token.reduceSequences(Token.SEQUENCES, input);
      if (sequence) return [sequence, ...process(input.slice(sequence.text.length))];

      let buffer = char;
      let pendingResults = Token.reducePatterns(Token.PATTERNS, buffer);

      if (pendingResults.length) {
        for (const peek of next) {
          buffer += peek;

          const peekResults = Token.reducePatterns(Token.PATTERNS, buffer);

          if (!peekResults.length) {
            return [pendingResults[0]!, ...process(next.slice(buffer.length - 2))];
          }

          pendingResults = peekResults;
        }
      }

      if (pendingResults.length) {
        return [pendingResults[0]!];
      }

      throw new Error(`failed to tokenize input\nbuffer: ${buffer}\ninput:${input}`);
    };

    return process(text);
  }

  public abstract toString(): string;
}

export const SequenceToken = (pattern: RegExp) =>
  class extends Token {
    public static readonly PATTERN = pattern;

    public static match(text: string) {
      return text.match(pattern)?.[0] ?? null;
    }

    constructor(public readonly text: string) {
      super();
    }

    public override toString() {
      return this.text;
    }
  };

export class DieRollToken extends SequenceToken(/^(?<count>[1-9]\d*)d(?<sides>[1-9]\d*)/) {
  public readonly dieRoll: DieRoll;

  constructor(text: string) {
    super(text);

    const match = text.match(DieRollToken.PATTERN);
    if (!match?.groups) throw new Error('invalid construction of DieRollToken');

    this.dieRoll = new DieRoll(Number(match.groups.count), new Die(Number(match.groups.sides)));
  }
}

export class StringToken extends SequenceToken(/^'(?<value>(?:[^']|\\')*)'/) {
  public readonly value: string;

  constructor(text: string) {
    super(text);

    const match = text.match(StringToken.PATTERN);
    if (!match?.groups) throw new Error('invalid construction of StringToken');

    this.value = match.groups.value!;
  }
}

export const PatternToken = (pattern: RegExp) =>
  class extends Token {
    public static readonly PATTERN = pattern;

    public static match(text: string) {
      return !!text.match(pattern);
    }

    constructor(public readonly text: string) {
      super();
    }

    public override toString() {
      return this.text;
    }
  };

export class DigitsToken extends PatternToken(/^\d+$/) {}

export class WordToken extends PatternToken(/^[a-zA-Z_]\w*$/) {}

export const CharacterToken = (
  character: ':' | '@' | '.' | ',' | '!' | '$' | '+' | '-' | '=' | '*' | '~' | '#' | '(' | ')' | '/',
) =>
  class extends Token {
    public static readonly CHARACTER = character;

    public override toString() {
      return character;
    }
  };

export class ColonToken extends CharacterToken(':') {}
export class AtSignToken extends CharacterToken('@') {}
export class PeriodToken extends CharacterToken('.') {}
export class CommaToken extends CharacterToken(',') {}
export class ExclamationMarkToken extends CharacterToken('!') {}
export class DollarSignToken extends CharacterToken('$') {}
export class PlusSignToken extends CharacterToken('+') {}
export class MinusSignToken extends CharacterToken('-') {}
export class EqualSignToken extends CharacterToken('=') {}
export class AsteriskToken extends CharacterToken('*') {}
export class TildeToken extends CharacterToken('~') {}
export class OctothorpeToken extends CharacterToken('#') {}
export class OpenParenthesisToken extends CharacterToken('(') {}
export class CloseParenthesisToken extends CharacterToken(')') {}
export class ForwardSlashToken extends CharacterToken('/') {}
