import * as glob from 'fast-glob';

import { FILE_EXTENSION } from './constants';
import { Document } from './models/document';
import { Namespace } from './models/namespace';

export class Compiler {
  private documents = new Map<Namespace, Document>();

  constructor(private readonly rootDir: string) {}

  public async run(): Promise<void> {
    const paths = await glob([`${this.rootDir}/**/*.${FILE_EXTENSION}`]);

    await Promise.all(
      paths.map((path) => {
        const doc = this.createDocument(path);
        this.documents.set(doc.namespace, doc);
        return doc.read();
      }),
    );
  }

  public createDocument(path: string): Document {
    const namespace = new Namespace(this.rootDir, path);
    return new Document(namespace);
  }
}
