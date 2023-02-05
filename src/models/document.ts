import * as fs from 'node:fs/promises';

import { Namespace } from './namespace';
import { Node } from './node';

export class Document {
  public node!: Node;

  constructor(public readonly namespace: Namespace) {}

  public async read() {
    const buffer = await fs.readFile(this.namespace.uri);
    const data = JSON.parse(buffer.toString());

    this.node = Node.from(data);

    console.log(this.namespace.uuid, this.node.toString());
  }
}
