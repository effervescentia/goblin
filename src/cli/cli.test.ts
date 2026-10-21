import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANION_PARAMS } from '@test/dnd5e.fixtures';
import { decode, decodeMultiple, encode } from 'cbor-x';
import { describe, expect, it } from 'vitest';
import { type InputEvent, invoke, latest, nest, override, parameter, paramValue } from '@/inputs';
import { print } from '@/nodes/serialize';
import { parseArgs, parseParamValue, rehydrate, weave, withHash } from './cli';
import { USAGE } from './constants';

describe('parseArgs', () => {
  it('defaults to no entry and pretty output', () => {
    expect(parseArgs([])).toEqual({
      entry: undefined,
      compact: false,
      stripMetadata: false,
      help: false,
      stateless: false,
      events: [],
    });
  });

  it('accepts a positional entry file', () => {
    expect(parseArgs(['player.yaml'])).toEqual({
      entry: 'player.yaml',
      compact: false,
      stripMetadata: false,
      help: false,
      stateless: false,
      events: [],
    });
  });

  it('accepts --compact', () => {
    expect(parseArgs(['--compact'])).toEqual({
      entry: undefined,
      compact: true,
      stripMetadata: false,
      help: false,
      stateless: false,
      events: [],
    });
    expect(parseArgs(['main.yaml', '--compact'])).toEqual({
      entry: 'main.yaml',
      compact: true,
      stripMetadata: false,
      help: false,
      stateless: false,
      events: [],
    });
  });

  it('accepts --strip-metadata', () => {
    expect(parseArgs(['--strip-metadata'])).toEqual({
      entry: undefined,
      compact: false,
      stripMetadata: true,
      help: false,
      stateless: false,
      events: [],
    });
    expect(parseArgs(['main.yaml', '--compact', '--strip-metadata'])).toEqual({
      entry: 'main.yaml',
      compact: true,
      stripMetadata: true,
      help: false,
      stateless: false,
      events: [],
    });
  });

  it('accepts --help and -h', () => {
    expect(parseArgs(['--help'])).toEqual({
      entry: undefined,
      compact: false,
      stripMetadata: false,
      help: true,
      stateless: false,
      events: [],
    });
    expect(parseArgs(['-h'])).toEqual({
      entry: undefined,
      compact: false,
      stripMetadata: false,
      help: true,
      stateless: false,
      events: [],
    });
  });

  it('accepts repeatable --param key=value', () => {
    expect(parseArgs(['--param', 'hero_name=Aria'])).toEqual({
      entry: undefined,
      compact: false,
      stripMetadata: false,
      help: false,
      stateless: false,
      events: [{ type: 'parameter', path: 'hero_name', value: 'Aria' }],
    });
    expect(parseArgs(['--param', 'level=3', '--param', 'name=Aria'])).toEqual({
      entry: undefined,
      compact: false,
      stripMetadata: false,
      help: false,
      stateless: false,
      events: [
        { type: 'parameter', path: 'level', value: 3 },
        { type: 'parameter', path: 'name', value: 'Aria' },
      ],
    });
  });

  it('parses --param array values', () => {
    expect(parseArgs(['--param', 'skills.trained=["athletics","perception"]'])).toEqual({
      entry: undefined,
      compact: false,
      stripMetadata: false,
      help: false,
      stateless: false,
      events: [{ type: 'parameter', path: 'skills.trained', value: ['athletics', 'perception'] }],
    });
  });

  it('splits --param on the first =', () => {
    expect(parseArgs(['--param', 'a=b=c']).events).toEqual([{ type: 'parameter', path: 'a', value: 'b=c' }]);
  });

  it('rejects malformed --param', () => {
    expect(() => parseArgs(['--param'])).toThrow('--param expects key=value');
    expect(() => parseArgs(['--param', 'nokey'])).toThrow('--param expects key=value');
    expect(() => parseArgs(['--param', '=novalue'])).toThrow('--param expects key=value');
  });

  it('accepts repeatable --set path=value, keeping every flag in the order given', () => {
    expect(parseArgs(['--set', 'level=5'])).toEqual({
      entry: undefined,
      compact: false,
      stripMetadata: false,
      help: false,
      stateless: false,
      events: [{ type: 'override', path: 'level', value: 5 }],
    });
    expect(
      parseArgs(['--set', 'level=5', '--param', 'name=Aria', '--set', 'a.b=1', '--set', 'level=6']).events,
    ).toEqual([
      { type: 'override', path: 'level', value: 5 },
      { type: 'parameter', path: 'name', value: 'Aria' },
      { type: 'override', path: 'a.b', value: 1 },
      { type: 'override', path: 'level', value: 6 },
    ]);
  });

  it('accepts one --invoke per run, by path with JSON arguments', () => {
    expect(parseArgs(['--invoke', 'rest.short']).events).toEqual([{ type: 'invoke', path: 'rest.short', value: [] }]);
    expect(parseArgs(['--invoke', 'heal()']).events).toEqual([{ type: 'invoke', path: 'heal', value: [] }]);
    expect(parseArgs(['--invoke', 'pick("str", [1, 2])']).events).toEqual([
      { type: 'invoke', path: 'pick', value: ['str', [1, 2]] },
    ]);
    expect(() => parseArgs(['--invoke'])).toThrow('--invoke expects fn or fn(args)');
    expect(() => parseArgs(['--invoke', 'heal(x)'])).toThrow('--invoke arguments must be JSON values');
    expect(() => parseArgs(['--invoke', 'a', '--invoke', 'b'])).toThrow('--invoke may be given once per run');
  });

  it('rejects --invoke alongside --param or --set, in either order', () => {
    const alone = '--invoke cannot be combined with --param or --set';
    expect(() => parseArgs(['--param', 'a=1', '--invoke', 'f'])).toThrow(alone);
    expect(() => parseArgs(['--invoke', 'f', '--set', 'a=1'])).toThrow(alone);
  });

  it('rejects malformed --set', () => {
    expect(() => parseArgs(['--set'])).toThrow('--set expects key=value');
    expect(() => parseArgs(['--set', 'nokey'])).toThrow('--set expects key=value');
    expect(() => parseArgs(['--set', '=novalue'])).toThrow('--set expects key=value');
  });

  it('accepts --out with a path', () => {
    expect(parseArgs(['main.yaml', '--out', 'out/sheet.json']).out).toBe('out/sheet.json');
    expect(() => parseArgs(['--out'])).toThrow('--out expects a file path');
    expect(() => parseArgs(['--out', '--compact'])).toThrow('--out expects a file path');
  });

  it('accepts --in with a path or - for stdin', () => {
    expect(parseArgs(['main.yaml', '--in', 'state.json']).in).toBe('state.json');
    expect(parseArgs(['main.yaml', '--in', '-']).in).toBe('-');
    expect(() => parseArgs(['--in'])).toThrow('--in expects a file path or -');
    expect(() => parseArgs(['--in', '--compact'])).toThrow('--in expects a file path or -');
  });

  it('rejects unexpected arguments', () => {
    expect(() => parseArgs(['--bogus'])).toThrow('unexpected argument');
    expect(() => parseArgs(['a.yaml', 'b.yaml'])).toThrow('unexpected argument');
  });
});

describe('parseArgs --server', () => {
  it('accepts --server stdio with an entry and --in', () => {
    expect(parseArgs(['--server', 'stdio', 'a.yaml', '--in', 'state.json'])).toMatchObject({
      server: 'stdio',
      entry: 'a.yaml',
      in: 'state.json',
    });
  });

  it.each(['http', 'websocket'])('accepts --server %s with a --port', (mode) => {
    expect(parseArgs(['--server', mode]).port).toBeUndefined();
    expect(parseArgs(['--port', '0', '--server', mode])).toMatchObject({ server: mode, port: 0 });
  });

  it.each([[], ['tcp'], ['a.yaml']])('rejects --server %s', (...mode) => {
    expect(() => parseArgs(['--server', ...mode])).toThrow('--server expects stdio, http or websocket');
  });

  it('accepts --format with either server, leaving the default to the transport', () => {
    expect(parseArgs(['--server', 'stdio']).format).toBeUndefined();
    expect(parseArgs(['--server', 'stdio', '--format', 'json']).format).toBe('json');
    expect(parseArgs(['--format', 'cbor', '--server', 'http']).format).toBe('cbor');
    expect(parseArgs(['--server', 'websocket', '--format', 'json']).format).toBe('json');
  });

  it('rejects a bad --format, or one without --server', () => {
    expect(() => parseArgs(['--server', 'http', '--format'])).toThrow('--format expects cbor or json');
    expect(() => parseArgs(['--server', 'http', '--format', 'xml'])).toThrow('--format expects cbor or json');
    expect(() => parseArgs(['--format', 'json'])).toThrow('--format needs --server');
  });

  it('takes --stateless only with --server', () => {
    expect(parseArgs(['--server', 'stdio']).stateless).toBe(false);
    expect(parseArgs(['--stateless', '--server', 'http']).stateless).toBe(true);
    expect(() => parseArgs(['--stateless'])).toThrow('--stateless needs --server');
    expect(() => parseArgs(['a.yaml', '--stateless'])).toThrow('--stateless needs --server');
  });

  it('takes --history, an integer >= 1, only with a stateful --server', () => {
    expect(parseArgs(['--server', 'stdio']).history).toBeUndefined();
    expect(parseArgs(['--history', '1', '--server', 'http']).history).toBe(1);
    expect(parseArgs(['--server', 'websocket', '--history', '100']).history).toBe(100);
    for (const bad of [[], ['0'], ['-1'], ['1.5'], ['ten']])
      expect(() => parseArgs(['--server', 'stdio', '--history', ...bad])).toThrow('--history expects an integer >= 1');
    expect(() => parseArgs(['--history', '5'])).toThrow('--history needs a stateful --server');
    expect(() => parseArgs(['--server', 'http', '--stateless', '--history', '5'])).toThrow(
      '--history needs a stateful --server',
    );
  });

  it('rejects a bad --port, or one without --server http or websocket', () => {
    expect(() => parseArgs(['--server', 'http', '--port'])).toThrow('--port expects a port number');
    expect(() => parseArgs(['--server', 'http', '--port', '-1'])).toThrow('--port expects a port number');
    expect(() => parseArgs(['--server', 'http', '--port', '65536'])).toThrow('--port expects a port number');
    expect(() => parseArgs(['--server', 'stdio', '--port', '80'])).toThrow('--port needs --server http or websocket');
    expect(() => parseArgs(['--port', '80'])).toThrow('--port needs --server http or websocket');
  });

  it.each([
    ['--param', 'level=3'],
    ['--set', 'level=3'],
    ['--invoke', 'heal(5)'],
    ['--out', 'out.json'],
    ['--strip-metadata'],
    ['--compact'],
  ])('rejects %s alongside --server', (...flag) => {
    expect(() => parseArgs(['--server', 'stdio', ...flag])).toThrow(`--server cannot be combined with ${flag[0]}`);
    expect(() => parseArgs([...flag, '--server', 'http'])).toThrow(`--server cannot be combined with ${flag[0]}`);
  });
});

describe('print', () => {
  it('drops :-prefixed and !validate keys recursively, keeping values', () => {
    expect(
      print({
        name: 'Aria',
        hit_points: { '!validate': ['.current >= 0'], current: 10, max: 10 },
        features: { second_wind: { ':doc': 'Regain.' } },
        utils: {
          ability_modifier: { ':type': 'function', ':params': ['x'], ':source': 'x * 2', ':deps': [] },
          partial: { ':type': 'function' },
        },
        tags: [{ ':doc': 't', label: 'a' }, 'b'],
        level: 5,
        xp: { ':doc': 'XP.', ':param': true, ':type': 'integer', ':default': 0, ':value': 6500 },
        nick: { ':param': true, ':value': null },
        attacks: { ':value': 2, ':events': [{ ':source': 'fighter.yaml', ':set': '1 + (@.level >= 5)' }] },
        armor: { ':value': ['shields'], ':events': [{ ':add': ['shields'] }] },
      }),
    ).toEqual({
      name: 'Aria',
      hit_points: { current: 10, max: 10 },
      features: { second_wind: null },
      utils: { ability_modifier: 'x * 2', partial: null },
      tags: [{ label: 'a' }, 'b'],
      level: 5,
      xp: 6500,
      nick: null,
      attacks: 2,
      armor: ['shields'],
    });
    expect(print('d10')).toBe('d10');
    expect(print(null)).toBeNull();
  });
});

describe('parseParamValue', () => {
  it('parses JSON, falling back to strings', () => {
    expect(parseParamValue('3')).toBe(3);
    expect(parseParamValue('true')).toBe(true);
    expect(parseParamValue('["a"]')).toEqual(['a']);
    expect(parseParamValue('Aria')).toBe('Aria');
    expect(parseParamValue('1d8')).toBe('1d8');
  });
});

const sha = (body: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;

describe('inputs', () => {
  const events: InputEvent[] = [
    { version: 1, type: 'parameter', path: 'level', value: 2 },
    { version: 1, type: 'override', path: 'hp', value: 10 },
    { version: 2, type: 'parameter', path: 'level', value: 5 },
    { version: 3, type: 'override', path: 'party.aria.hp', value: 7 },
    { version: 3, type: 'override', path: 'hp', value: 12 },
  ];

  it('keeps the latest event of a type per path, ordered by arrival', () => {
    expect(latest(events, 'override')).toEqual([events[3], events[4]]);
    expect(latest(events, 'parameter')).toEqual([events[2]]);
  });

  it('reads the latest param value for the first path given one', () => {
    expect(paramValue(events, 'level')).toBe(5);
    expect(paramValue(events, 'missing', 'level')).toBe(5);
    expect(paramValue(events, 'hp')).toBeUndefined();
  });

  it('re-paths events nested under a path', () => {
    expect(nest(events, ['party', 'aria'])).toEqual([{ version: 3, type: 'override', path: 'hp', value: 7 }]);
    expect(nest(events, [])).toEqual(events);
    expect(nest(undefined, ['x'])).toEqual([]);
  });
});

describe('weave', () => {
  const write = (path: string, value: unknown) => ({ type: 'add' as const, path, value, source: 'a.yaml' });

  it("places writes in the order made: resolving ones before the first invoke, each invoke's after it", () => {
    const heal = invoke('heal', [2], 2);
    const inputs = [parameter('name', 'Aria', 1), heal, override('hp', 1, 3)];
    const writes = [
      { event: write('gold', 5) },
      { version: 1, event: write('speed', 10) },
      { cause: heal, phase: heal, event: write('hp', 2) },
      { phase: heal, event: write('budget', 27) },
    ];
    expect(weave(inputs, writes, 3)).toEqual([
      inputs[0],
      { version: 3, ...write('gold', 5) },
      { version: 1, ...write('speed', 10) },
      heal,
      { version: 2, ...write('hp', 2) },
      { version: 3, ...write('budget', 27) },
      inputs[2],
    ]);
  });

  it('closes the stream with the writes when nothing was invoked', () => {
    const inputs = [parameter('name', 'Aria', 1)];
    expect(weave(inputs, [{ event: write('gold', 5) }], 2)).toEqual([inputs[0], { version: 2, ...write('gold', 5) }]);
  });
});

describe('withHash', () => {
  const events: InputEvent[] = [
    { version: 1, type: 'parameter', path: 'name', value: 'Aria' },
    { version: 1, type: 'override', path: 'level', value: 5 },
  ];

  it('stamps data envelopes with their events and a sha256 over the rest', () => {
    const body = { version: 1, events, data: { a: 1 } };
    expect(withHash({ data: { a: 1 } }, events)).toEqual({ hash: sha(body), ...body });
    const hash = (data: unknown, given = events) => (withHash({ data }, given) as { hash: string }).hash;
    expect(hash({ a: 2 })).not.toBe(hash({ a: 1 }));
    expect(hash({ a: 1 }, events.slice(1))).not.toBe(hash({ a: 1 }));
    expect(withHash({ data: { a: 1 } }, events, 2)).toMatchObject({ version: 2 });
    expect((withHash({ data: { a: 1 } }, events, 2) as { hash: string }).hash).not.toBe(hash({ a: 1 }));
  });

  it('hashes a result alongside the data', () => {
    const body = { version: 1, events, result: 42, data: { a: 1 } };
    expect(withHash({ result: 42, data: { a: 1 } }, events)).toEqual({ hash: sha(body), ...body });
  });

  it('stamps query envelopes too, and leaves errors alone', () => {
    const body = { version: 1, events, query: [{ path: 'name' }] };
    expect(withHash({ query: [{ path: 'name' }] }, events)).toEqual({ hash: sha(body), ...body });
    expect(withHash({ errors: ['x'] }, events)).toEqual({ errors: ['x'] });
  });
});

describe('rehydrate', () => {
  const events: InputEvent[] = [
    { version: 1, type: 'parameter', path: 'name', value: 'Aria' },
    { version: 2, type: 'override', path: 'hp.max', value: 14 },
  ];

  it('verifies a result and accepts invoke events', () => {
    const invoked = [...events, invoke('heal', [2], 3)];
    const state = withHash({ result: 7, data: { x: 1 } }, invoked, 3) as Record<string, unknown>;
    expect(rehydrate(state)).toEqual({ version: 3, events: invoked, stable: true });
    expect(() => rehydrate({ ...state, result: 8 })).toThrow('hash does not match');
    expect(() => rehydrate({ data: {}, events: [{ version: 1, type: 'invoke', path: 'x', value: 2 }] })).toThrow(
      'events must be',
    );
  });

  it('keeps recorded writes, whose rolls the engine replays', () => {
    const writes = [{ version: 1, type: 'add', path: 'gold', value: 5, rolled: true, source: 'boon.yaml' }];
    const stream = [...events, ...(writes as never[])];
    expect(rehydrate(withHash({ data: { x: 1 } }, stream))).toEqual({ version: 1, events: stream, stable: true });
    expect(() => rehydrate({ data: {}, events: [{ ...writes[0], rolled: 'yes' }] })).toThrow('events must be');
  });

  it('returns the version and events a state was resolved with', () => {
    expect(rehydrate(withHash({ data: { x: 1 } }, events, 3))).toEqual({ version: 3, events, stable: true });
    expect(rehydrate({ data: { x: 1 } })).toEqual({ version: 0, events: [], stable: true });
  });

  it('accepts a query state as unstable, verifying its hash', () => {
    const state = withHash({ query: [{ path: 'name' }] }, events, 2) as Record<string, unknown>;
    expect(rehydrate(state)).toEqual({ version: 2, events, stable: false });
    expect(() => rehydrate({ ...state, query: [] })).toThrow('hash does not match');
  });

  it('rejects edited states, bad inputs, and non-data envelopes', () => {
    const state = withHash({ data: { x: 1 } }, events) as Record<string, unknown>;
    expect(() => rehydrate({ ...state, events: events.slice(1) })).toThrow('hash does not match');
    expect(() => rehydrate({ ...state, data: { x: 2 } })).toThrow('hash does not match');
    expect(() => rehydrate({ ...state, version: 7 })).toThrow('hash does not match');
    expect(() => rehydrate({ data: {}, version: -1 })).toThrow('non-negative integer');
    expect(() => rehydrate({ data: {}, events: {} })).toThrow('events must be');
    expect(() => rehydrate({ data: {}, events: [{ version: 1, type: 'remove', path: 'x', value: 1 }] })).toThrow(
      'events must be',
    );
    expect(() => rehydrate({ data: {}, events: [{ version: 1, type: 'override', path: 'x' }] })).toThrow(
      'events must be',
    );
    expect(() => rehydrate({ errors: [] })).toThrow('{ "data": … } or { "query": … } envelope');
  });
});

describe('USAGE', () => {
  it('documents the CLI', () => {
    expect(USAGE).toContain(
      'goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--invoke fn(args)] [--strip-metadata] [--in state.json|-] [--out file.json] [--server stdio|http|websocket] [--stateless] [--history n] [--format cbor|json] [--port n] [--help]',
    );
    expect(USAGE).toContain('--stateless');
    expect(USAGE).toContain('--history');
    expect(USAGE).toContain('--out');
    expect(USAGE).toContain('--in');
    expect(USAGE).toContain('--compact');
    expect(USAGE).toContain('--strip-metadata');
    expect(USAGE).toContain('--param');
    expect(USAGE).toContain('--set');
    expect(USAGE).toContain('--help, -h');
  });
});

// Subprocess tests through the real entry point (Bun-only code paths).
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function runCli(...args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('bun', ['src/cli/cli.ts', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const failed = err as { stdout?: unknown; stderr?: unknown; status?: unknown };
    return {
      stdout: String(failed.stdout ?? ''),
      stderr: String(failed.stderr ?? ''),
      status: typeof failed.status === 'number' ? failed.status : 1,
    };
  }
}

describe('cli', () => {
  it('uses .goblin.yaml from cwd when no entry is supplied', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goblin-cli-'));
    mkdirSync(join(cwd, 'docs', 'nested'), { recursive: true });
    writeFileSync(join(cwd, '.goblin.yaml'), 'root: docs\nmain: nested/actor.yaml\n');
    writeFileSync(join(cwd, 'docs', 'nested', 'actor.yaml'), 'name: Config actor\n');
    try {
      const stdout = execFileSync('bun', [join(root, 'src/cli/cli.ts')], { cwd, encoding: 'utf8' });
      expect(JSON.parse(stdout)).toMatchObject({ version: 1, events: [], data: { name: 'Config actor' } });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('defaults .goblin.yaml root to cwd', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goblin-cli-'));
    writeFileSync(join(cwd, '.goblin.yaml'), 'main: actor.yaml\n');
    writeFileSync(join(cwd, 'actor.yaml'), 'name: Rootless\n');
    try {
      const stdout = execFileSync('bun', [join(root, 'src/cli/cli.ts')], { cwd, encoding: 'utf8' });
      expect(JSON.parse(stdout)).toMatchObject({ data: { name: 'Rootless' } });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('errors on a .goblin.yaml missing main', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goblin-cli-'));
    writeFileSync(join(cwd, '.goblin.yaml'), 'root: docs\n');
    try {
      expect(() =>
        execFileSync('bun', [join(root, 'src/cli/cli.ts')], {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ).toThrow(/invalid \.goblin\.yaml[\s\S]*main/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('errors when no entry or .goblin.yaml is available', () => {
    const res = runCli();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('no entry provided and .goblin.yaml was not found');
  });

  it('--help prints usage and exits 0', () => {
    const res = runCli('--help');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('goblin [entry.yaml]');
  });

  it('rejects unknown flags with exit 1', () => {
    const res = runCli('--bogus');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unexpected argument: --bogus');
  });

  it('errors on missing entry files', () => {
    const res = runCli('nope.yaml');
    expect(res.status).toBe(1);
    expect(res.stderr.length).toBeGreaterThan(0);
  });

  it('--compact emits single-line JSON, default pretty-prints', () => {
    const compact = runCli('examples/02-expressions.yaml', '--compact');
    expect(compact.status).toBe(0);
    expect(JSON.parse(compact.stdout)).toMatchObject({ data: { sum: 29 } });
    expect(compact.stdout.trimEnd().includes('\n')).toBe(false);

    const pretty = runCli('examples/02-expressions.yaml');
    expect(pretty.status).toBe(0);
    expect(pretty.stdout.trimEnd().includes('\n')).toBe(true);
    expect(JSON.parse(pretty.stdout)).toEqual(JSON.parse(compact.stdout));
  });

  it('--out replaces the file with a resolved or asking state, never errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goblin-out-'));
    const out = join(dir, 'nested', 'sheet.json');
    try {
      mkdirSync(join(dir, 'nested'));
      writeFileSync(out, 'stale');
      const res = runCli('examples/02-expressions.yaml', '--compact', '--out', out);
      expect(res.status).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe(res.stdout);

      const pending = join(dir, 'pending.json');
      const query = runCli('examples/08-parameters.yaml', '--out', pending);
      expect(query.status).toBe(0);
      expect(JSON.parse(query.stdout)).toHaveProperty('query');
      expect(readFileSync(pending, 'utf8')).toBe(query.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--invoke prints a result for its own run, and --in replays the call without one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goblin-invoke-'));
    const state = join(dir, 'state.json');
    try {
      const first = runCli('examples/04-functions.yaml', '--compact', '--invoke', 'utils.double(21)', '--out', state);
      expect(first.status).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({
        events: [{ version: 1, type: 'invoke', path: 'utils.double', value: [21] }],
        result: 42,
      });
      const shield = runCli('examples/04-functions.yaml', '--strip-metadata', '--invoke', 'shield("Kite", 3)');
      expect(JSON.parse(shield.stdout).result).toEqual({ armor_class: 13 });

      const replayed = JSON.parse(runCli('examples/04-functions.yaml', '--in', state).stdout);
      expect(replayed).toMatchObject({ version: 2 });
      expect(replayed).not.toHaveProperty('result');

      const missing = runCli('examples/04-functions.yaml', '--invoke', 'nope');
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('invoke: nope is not a function');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--invoke needs a stable state: an entry or --in state that asks for nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goblin-stable-'));
    const pending = join(dir, 'pending.json');
    try {
      const fresh = runCli('examples/08-parameters.yaml', '--invoke', 'f');
      expect(fresh.status).toBe(1);
      expect(fresh.stderr).toContain('--invoke needs a stable state: the entry asks for params');

      expect(runCli('examples/08-parameters.yaml', '--out', pending).status).toBe(0);
      const asking = runCli('examples/08-parameters.yaml', '--in', pending, '--invoke', 'f');
      expect(asking.status).toBe(1);
      expect(asking.stderr).toContain('--invoke needs a stable state: --in still asks for params');

      // Answered in a later run, the saved query state resolves.
      const answered = runCli(
        'examples/08-parameters.yaml',
        '--compact',
        '--in',
        pending,
        '--param',
        'hero_name=Aria',
        '--param',
        'starting_level=3',
        '--param',
        'details.title=Kid',
      );
      expect(JSON.parse(answered.stdout)).toMatchObject({ version: 2, data: {} });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("weaves the engine's writes into events, keeping their versions on --in", () => {
    const dir = mkdtempSync(join(tmpdir(), 'goblin-writes-'));
    const state = join(dir, 'state.json');
    try {
      const first = JSON.parse(runCli('examples/14-mixin-actor.yaml', '--compact', '--out', state).stdout);
      const writes = [
        { version: 1, type: 'set', path: 'speed', value: 40, source: '14-mixin-boon.yaml', line: 8, column: 1 },
        { version: 1, type: 'add', path: 'gold', value: 5, source: '14-mixin-boon.yaml', line: 9, column: 1 },
      ];
      expect(first.events).toEqual(writes);
      const replayed = JSON.parse(runCli('examples/14-mixin-actor.yaml', '--compact', '--in', state).stdout);
      expect(replayed.events).toEqual(writes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--in replays every recorded roll, so dice land as they did', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goblin-rolls-'));
    const state = join(dir, 'state.json');
    try {
      const first = JSON.parse(runCli('examples/03-dice.yaml', '--compact', '--out', state).stdout);
      expect(first.events.map(({ type, path, dice }: Record<string, unknown>) => [type, path, dice])).toEqual([
        ['roll', 'initiative', '1d20'],
        ['roll', 'heal', '1d8'],
      ]);
      for (let i = 0; i < 3; i++) {
        const replayed = JSON.parse(runCli('examples/03-dice.yaml', '--compact', '--in', state).stdout);
        expect(replayed.events).toEqual(first.events);
        expect(replayed.data).toEqual(first.data);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--in replays the events saved in a prior output, file or stdin, appending new ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goblin-in-'));
    const state = join(dir, 'state.json');
    try {
      const first = runCli(
        'examples/08-parameters.yaml',
        '--compact',
        '--param',
        'hero_name=Aria',
        '--param',
        'starting_level=2',
        '--param',
        'details.title=Sir',
        '--set',
        'hit_points.max=12',
        '--out',
        state,
      );
      expect(first.status).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({
        version: 1,
        events: [
          { version: 1, type: 'parameter', path: 'hero_name', value: 'Aria' },
          { version: 1, type: 'parameter', path: 'starting_level', value: 2 },
          { version: 1, type: 'parameter', path: 'details.title', value: 'Sir' },
          { version: 1, type: 'override', path: 'hit_points.max', value: 12 },
        ],
      });
      const replayed = JSON.parse(runCli('examples/08-parameters.yaml', '--compact', '--in', state).stdout);
      const { hash: _, version: __, ...rest } = JSON.parse(first.stdout);
      expect(replayed).toMatchObject({ version: 2, ...rest });

      const piped = execFileSync('bun', ['src/cli/cli.ts', 'examples/08-parameters.yaml', '--in', '-'], {
        cwd: root,
        encoding: 'utf8',
        input: first.stdout,
      });
      const next = JSON.parse(piped) as { data: Record<string, Record<string, unknown>> };
      expect(next.data.hero_name?.[':value']).toBe('Aria');

      // This run's flags win over the rehydrated state.
      const bumped = runCli('examples/08-parameters.yaml', '--in', state, '--param', 'starting_level=5');
      const after = JSON.parse(bumped.stdout) as typeof next & { events: InputEvent[] };
      expect(after.data.level?.[':value']).toBe(5);
      expect(after.events.slice(4)).toEqual([{ version: 2, type: 'parameter', path: 'starting_level', value: 5 }]);

      writeFileSync(state, first.stdout.replace('"Aria"', '"Bob"'));
      const tampered = runCli('examples/08-parameters.yaml', '--in', state);
      expect(tampered.status).toBe(1);
      expect(tampered.stderr).toContain('hash does not match');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--strip-metadata drops metadata keys from data output', () => {
    // 5e/main.yaml nests its characters under `party`; this reads `aria`.
    const character = (data: Record<string, unknown>) =>
      (data.party as Record<string, Record<string, unknown>>).aria as Record<string, unknown>;
    const params = [
      '--param',
      'class=fighter',
      '--param',
      'species=dwarf',
      '--param',
      'ability_method=point_buy',
      '--param',
      'abilities.strength.bought=7',
      '--param',
      'abilities.dexterity.bought=6',
      '--param',
      'abilities.constitution.bought=5',
      '--param',
      'abilities.intelligence.bought=2',
      '--param',
      'abilities.wisdom.bought=2',
      '--param',
      'abilities.charisma.bought=0',
      '--param',
      'name=Aria',
      '--param',
      'xp=6500',
      '--param',
      'features.fighting_style=dueling',
      '--param',
      'features.martial_archetype=champion',
      '--param',
      'skills.trained=["athletics","perception"]',
      '--param',
      'improvements.level_4=["strength","strength"]',
    ].map((arg) => (arg === '--param' ? arg : `aria.${arg}`));
    const args = ['5e/main.yaml', '--compact', ...params, ...COMPANION_PARAMS];
    const full = runCli(...args);
    expect(full.status).toBe(0);
    const fullData = character((JSON.parse(full.stdout) as { data: Record<string, unknown> }).data);
    expect(JSON.stringify(fullData)).toContain(':doc');
    expect(fullData.name).toEqual({
      ':doc': "Your hero's name, as sung by bards.",
      ':param': true,
      ':type': 'string',
      ':value': 'Aria',
    });
    expect(fullData.xp).toEqual({
      ':doc': 'Experience points earned in play.',
      ':param': true,
      ':type': 'integer',
      ':default': 0,
      ':value': 6500,
    });

    const stripped = runCli(...args, '--strip-metadata');
    expect(stripped.status).toBe(0);
    const data = (JSON.parse(stripped.stdout) as { data: Record<string, unknown> }).data;
    const metaKeys: string[] = [];
    const visit = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k.startsWith(':') || k === '!validate') metaKeys.push(k);
          visit(v);
        }
      }
    };
    visit(data);
    expect(metaKeys).toEqual([]);
    const pc = character(data);
    expect(pc.hit_points).toEqual({ current: 11, max: 11 }); // con 13 → +1
    expect(pc.name).toBe('Aria');
    expect(pc.level).toBe(5);
    expect(pc.initiative).toEqual({ base: 2, roll: '1d20 + .base' }); // dex 14 → +2
    expect((pc.features as Record<string, unknown>).second_wind).toBeNull();
  });
});

// These check the wire, so they run --stateless: answers stay bare envelopes and nothing lands in ~/.goblin.
describe('cli --server stdio', () => {
  const server = (...messages: unknown[]): unknown[] => {
    const input = Buffer.concat(messages.map((message) => encode(message)));
    const stdout = execFileSync('bun', ['src/cli/cli.ts', '--server', 'stdio', '--stateless'], { cwd: root, input });
    return decodeMultiple(stdout) ?? [];
  };

  it('answers resolve turns with the envelope a run prints, until stdin ends', () => {
    const entry = 'examples/08-parameters.yaml';
    const [asking] = server({ jsonrpc: '2.0', id: 1, method: 'resolve', params: { entry } }) as [{ result: unknown }];
    expect(asking).toMatchObject({ jsonrpc: '2.0', id: 1, result: { version: 1, events: [] } });
    expect(asking.result).toEqual(JSON.parse(runCli(entry).stdout));

    const inputs = [
      { type: 'parameter', path: 'hero_name', value: 'Aria' },
      { type: 'parameter', path: 'starting_level', value: 3 },
      { type: 'parameter', path: 'details.title', value: 'Sir' },
    ];
    const [answered, missing] = server(
      { jsonrpc: '2.0', id: 2, method: 'resolve', params: { entry, in: asking.result, inputs } },
      { jsonrpc: '2.0', id: 3, method: 'resolve', params: { entry: 'nope.yaml' } },
    );
    const cli = runCli(
      entry,
      '--param',
      'hero_name=Aria',
      '--param',
      'starting_level=3',
      '--param',
      'details.title=Sir',
    );
    expect(answered).toMatchObject({ id: 2, result: { version: 2 } });
    expect((answered as { result: { data: unknown } }).result.data).toEqual(JSON.parse(cli.stdout).data);
    expect(missing).toMatchObject({ id: 3, error: { code: -32000 } });
  });

  it('speaks one JSON line per message under --format json', () => {
    const entry = 'examples/08-parameters.yaml';
    const input = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resolve', params: { entry } })}\n{\n`;
    const stdout = execFileSync('bun', ['src/cli/cli.ts', '--server', 'stdio', '--stateless', '--format', 'json'], {
      cwd: root,
      input,
    }).toString();
    const [asking, broken] = stdout
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(asking.result).toEqual(JSON.parse(runCli(entry).stdout));
    expect(broken).toMatchObject({ id: null, error: { code: -32700 } });
  });
});

interface Wire {
  flags: string[];
  type: string;
  write: (message: unknown) => BodyInit;
  read: (res: Response) => Promise<unknown>;
}

const WIRES: [string, Wire][] = [
  [
    'cbor',
    {
      flags: [],
      type: 'application/cbor',
      write: (message) => new Uint8Array(encode(message)),
      read: async (res) => decode(new Uint8Array(await res.arrayBuffer())),
    },
  ],
  [
    'json',
    {
      flags: ['--format', 'json'],
      type: 'application/json',
      write: (message) => JSON.stringify(message),
      read: (res) => res.json(),
    },
  ],
];

/** The URL a spawned server logs once it is up. */
const listening = (child: ChildProcessWithoutNullStreams) =>
  new Promise<string>((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const [, found] = stderr.match(/listening on (\S+)/) ?? [];
      if (found !== undefined) resolve(found);
    });
    child.on('exit', (code) => reject(new Error(`server exited (${code}): ${stderr}`)));
  });

describe('cli --server http', () => {
  it.each(WIRES)(
    'answers posted %s resolve turns with the envelope a run prints, logging its URL',
    async (_, { flags, type, write, read }) => {
      const child = spawn('bun', ['src/cli/cli.ts', '--server', 'http', '--stateless', '--port', '0', ...flags], {
        cwd: root,
      });
      try {
        const url = await listening(child);
        expect(new URL(url).hostname).toBe('127.0.0.1');
        const entry = 'examples/08-parameters.yaml';
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': type },
          body: write([
            { jsonrpc: '2.0', id: 1, method: 'resolve', params: { entry } },
            { jsonrpc: '2.0', id: 2, method: 'resolve', params: { entry: 'nope.yaml' } },
          ]),
        });
        expect(res.headers.get('content-type')).toBe(type);
        const [asking, missing] = (await read(res)) as [{ result: unknown }, unknown];
        expect(asking.result).toEqual(JSON.parse(runCli(entry).stdout));
        expect(missing).toMatchObject({ id: 2, error: { code: -32000 } });
      } finally {
        child.kill();
      }
    },
  );
});

describe('cli --server websocket', () => {
  it.each([
    [
      'cbor',
      [],
      (message: unknown) => new Uint8Array(encode(message)),
      (data: unknown) => decode(new Uint8Array(data as ArrayBuffer)),
    ],
    [
      'json',
      ['--format', 'json'],
      (message: unknown) => JSON.stringify(message),
      (data: unknown) => JSON.parse(data as string),
    ],
  ])('answers %s resolve frames with the envelope a run prints, logging its URL', async (_, flags, write, read) => {
    const child = spawn('bun', ['src/cli/cli.ts', '--server', 'websocket', '--stateless', '--port', '0', ...flags], {
      cwd: root,
    });
    try {
      const url = new URL(await listening(child));
      expect(url.protocol).toBe('ws:');
      expect(url.hostname).toBe('127.0.0.1');
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      const answers: unknown[] = [];
      const done = new Promise<void>((resolve, reject) => {
        ws.onmessage = (event) => {
          answers.push(read(event.data));
          if (answers.length === 2) resolve();
        };
        ws.onerror = () => reject(new Error('socket failed'));
      });
      await new Promise((resolve) => {
        ws.onopen = resolve;
      });
      const entry = 'examples/08-parameters.yaml';
      ws.send(write({ jsonrpc: '2.0', id: 1, method: 'resolve', params: { entry } }));
      ws.send(write({ jsonrpc: '2.0', id: 2, method: 'resolve', params: { entry: 'nope.yaml' } }));
      await done;
      ws.close();
      const [asking, missing] = answers as [{ result: unknown }, unknown];
      expect(asking).toMatchObject({ id: 1 });
      expect(asking.result).toEqual(JSON.parse(runCli(entry).stdout));
      expect(missing).toMatchObject({ id: 2, error: { code: -32000 } });
    } finally {
      child.kill();
    }
  });
});
