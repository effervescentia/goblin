import * as P from 'parsimmon';

import { Expression } from './base';

export class Argument extends Expression {
  public static PREFIX = ':';
  public static PATTERN = new RegExp(`${this.PREFIX}(\\w+)`);

  public static parse = P.regex(this.PATTERN, 1).map(
    (name) => new Argument(name),
  );

  constructor(public readonly name: string) {
    super();
  }

  // typeof() {
  //   return this.type;
  // }

  toString() {
    return `${Argument.name}(${this.name})`;
  }
}

export abstract class Reference extends Expression {
  public static SELF = '.';
  public static PARENT = '..';
}
export class FileReference extends Reference {
  public static ROOT = '@';
  public static SEPARATOR = '/';
  public static RELATIVE = new FileReference([this.SELF]);

  public static parse = P.alt(
    P.string(this.ROOT),
    P.string(this.PARENT),
    P.string(this.SELF),
  )
    .chain((base) =>
      P.seq(
        P.string(this.SEPARATOR),
        P.alt(P.regex(/\w+/), P.string(this.PARENT)),
      )
        .map(([, name]) => name)
        .atLeast(1)
        .map((rest) => [base, ...rest]),
    )
    .map((filePath) => new FileReference(filePath));

  constructor(public readonly path: string[]) {
    super();
  }

  toString() {
    return `${FileReference.name}(${this.path.join(', ')})`;
  }
}
export class DataReference extends Reference {
  public static ROOT = '#';
  public static ROOT_PATTERN = new RegExp(`${this.ROOT}(\\w+)`);
  public static SEPARATOR = '.';

  private static parseAbsolute = P.seqMap(
    FileReference.parse.or(P.of(FileReference.RELATIVE)),
    P.regex(this.ROOT_PATTERN, 1).chain((base) =>
      P.seq(P.string(this.SEPARATOR), P.regex(/\w+/))
        .map(([, name]) => name)
        .many()
        .map((rest) => [this.ROOT, base, ...rest]),
    ),
    (file, path) => new DataReference(file, path),
  );

  private static parseRelative = P.string(this.SEPARATOR)
    .atLeast(1)
    .map((prefix) =>
      prefix.length === 1
        ? [this.SELF]
        : Array.from({ length: prefix.length - 1 }, () => this.PARENT),
    )
    .chain((base) =>
      P.regex(/\w+/)
        .sepBy1(P.string(this.SEPARATOR))
        .map(
          (path) =>
            new DataReference(FileReference.RELATIVE, [...base, ...path]),
        ),
    );

  public static parse = P.alt(this.parseAbsolute, this.parseRelative);

  constructor(
    public readonly file: FileReference,
    public readonly path: string[],
  ) {
    super();
  }

  toString() {
    return `${DataReference.name}(${this.file.toString()}, ${this.path.join(
      ', ',
    )})`;
  }
}
