import path from 'node:path';
import { YAML } from 'bun';
import { App } from './framework/app';
import type { GoblinOptions } from './types';

const options = (await Bun.file('.goblin.yaml').text().then(YAML.parse)) as GoblinOptions;

const rootDir = path.resolve(options.root);
const main = path.join(rootDir, options.main);

const process = async (app: App, file: string) => {
  const program = await Bun.file(file).text().then(YAML.parse);

  app.document(file, program);
};

const app = new App(main);

await process(app, main);

console.log(JSON.stringify(await app.evaluate(), null, 2));
