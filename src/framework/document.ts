import type { App } from './app';
import type { DocumentContext } from './context';
import { Node } from './node';

export class Document {
  public readonly root: Node;

  constructor(
    public readonly app: App,
    public readonly file: string,
    data: unknown,
  ) {
    this.root = this.node(data);
  }

  public readonly node = (data: unknown) => {
    return Node.parse(this, data);
  };

  public isReady() {
    return this.root.isReady();
  }

  public isValid() {
    return this.root.isValid();
  }

  public register(context: DocumentContext) {
    this.root.register(context.node());
  }

  public serialize(context: DocumentContext) {
    return this.root.serialize(context.node());
  }

  public toString() {
    return `${Document.name}(${this.root})`;
  }
}
