import path from 'node:path';
import { Template } from './template';

export const tmpl = (file: string) => new Template(path.resolve(file));

export const math = {
  floor: Math.floor,
  min: Math.min,
};
