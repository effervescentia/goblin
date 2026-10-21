/**
 * Starting a `goblin --server` as a child process. `node:child_process` loads
 * lazily, so clients that only connect stay usable where it does not exist.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ServerMode } from '@/cli/dtos';
import type { Format } from '@/server/dtos';
import type { Spawn } from './dtos';

export interface Server {
  child: ChildProcessWithoutNullStreams;
  /** The exit code, once the process is gone. */
  exited: Promise<number | null>;
  /** Everything the server has logged so far. */
  stderr: () => string;
}

export async function spawnServer(spawn: Spawn, mode: ServerMode, format: Format, port?: number): Promise<Server> {
  const { spawn: start } = await import('node:child_process');
  const flags = ['--server', mode, '--format', format, ...(port === undefined ? [] : ['--port', String(port)])];
  const child = start(spawn.command ?? 'goblin', [...(spawn.args ?? []), ...flags], {
    cwd: spawn.cwd,
    env: spawn.env === undefined ? undefined : { ...process.env, ...spawn.env },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('error', (err) => {
      stderr += err.message;
      resolve(null);
    });
    child.on('exit', resolve);
  });
  return { child, exited, stderr: () => stderr };
}

/** The URL an HTTP or WebSocket server logs once it is up. */
export function listening({ child, exited, stderr }: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    const found = () => {
      const url = stderr().match(/listening on (\S+)/)?.[1];
      if (url !== undefined) resolve(url);
    };
    found();
    child.stderr.on('data', found);
    exited.then((code) => reject(exitError(code, stderr())));
  });
}

export const exitError = (code: number | null, stderr: string) =>
  new Error(`server exited (${code ?? 'failed to start'})${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`);

/** Stop a server that would not exit on its own. */
export async function stop({ child, exited }: Server): Promise<void> {
  child.kill();
  await exited;
}
