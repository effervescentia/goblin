import * as path from 'node:path';

export class Namespace {
  public static fromURI(rootDir: string, uri: string): string {
    return `@/${path.relative(rootDir, uri).slice(0, -4)}`;
  }

  public uuid: string;

  constructor(rootDir: string, public readonly uri: string) {
    this.uuid = Namespace.fromURI(rootDir, uri);
  }
}
