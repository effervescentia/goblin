import indentString from 'indent-string';
import { Actor } from './actor';
import { AppContext } from './context';
import { Document } from './document';

export class App {
  private readonly actors = new Set<Actor>();
  private readonly documents = new Set<Document>();

  constructor(public readonly file: string) {}

  public readonly actor = () => {
    const actor = new Actor(this);
    this.actors.add(actor);
    return actor;
  };

  public readonly document = (file: string, data: unknown) => {
    const document = new Document(this, file, data);
    this.documents.add(document);
    return document;
  };

  public isReady() {
    return this.documents.values().every((document) => document.isReady());
  }

  public isValid() {
    return this.documents.values().every((document) => document.isValid());
  }

  public async evaluate() {
    const context = new AppContext(this);

    this.documents.values().forEach((document) => document.register(context.document(document.file)));

    await context.solve();

    return context.serialize();
  }

  public toString() {
    return Array.from(this.documents.values())
      .map((document) => `${document.file}:\n${indentString(document.toString())}`)
      .join('\n');
  }
}
