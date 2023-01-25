/* eslint-disable @typescript-eslint/ban-types */
import { Command, Interfaces } from '@oclif/core';

import { Compiler } from '../compiler';

interface RunArgs {
  rootDir: string;
}

export class Run extends Command {
  static description = 'Execute a goblin program';

  static flags = {};

  static args: Interfaces.ArgInput = [
    {
      name: 'rootDir',
      default: '.',
    },
  ];

  async run(): Promise<void> {
    const { args } = await this.parse<Interfaces.FlagOutput, {}, RunArgs>(Run);
    const compiler = new Compiler(args.rootDir);

    await compiler.run();
  }
}
