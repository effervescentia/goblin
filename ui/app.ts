/// <reference lib="dom" />
/**
 * Goblin inspector: resolves an entry through `/api/resolve`, answers its
 * `{ query }` turn by turn, and renders the resolved app — every field, the
 * fields each one reads (and is read by), and the `:events` behind it.
 */
import type { InspectNode } from '@/inspect';
import type { MissingParam } from '@/nodes/record';

type GoblinEvent = Record<string, unknown>;

interface Resolution {
  data?: unknown;
  query?: MissingParam[];
  errors?: string[];
  failure?: string;
  nodes?: InspectNode[];
}

const state = {
  entry: '',
  params: {} as Record<string, unknown>,
  /** Values forced by path (the CLI's `--set`): they beat params, patches and expressions. */
  overrides: {} as Record<string, unknown>,
  result: undefined as Resolution | undefined,
  selected: '',
  collapsed: new Set<string>(),
  filter: '',
  source: '' as string,
  /** The document an event's location link opened, if any. */
  viewing: undefined as { file: string; line: number; column: number } | undefined,
};

/** Fetched document text, by entry-relative file name. */
const sources = new Map<string, string>();

// -- dom helpers --------------------------------------------------------------

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value as EventListener);
    else if (key === 'style') el.setAttribute('style', String(value));
    else if (key in el && key !== 'list') (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function preview(value: unknown, max = 48): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A stable hue per source document, so its events read as one color. */
function sourceStyle(source: string): string {
  let hash = 0;
  for (const c of source) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return `--hue: ${hash % 360}`;
}

function sourceChip(source: string | undefined): HTMLElement {
  const name = source ?? 'unnamed';
  return h('span', { className: 'source', style: sourceStyle(name), title: name }, name);
}

/** A JSON value as a tree: scalars inline, objects and lists behind a
 * one-line `<details>` summary. Toggling never selects the row it sits in. */
function jsonView(value: unknown): HTMLElement {
  if (value === null || typeof value !== 'object') {
    const type = value === null ? 'null' : typeof value;
    return h('code', { className: `json-${type}` }, JSON.stringify(value) ?? 'undefined');
  }
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, i) => [String(i), item])
    : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return h('code', {}, Array.isArray(value) ? '[]' : '{}');
  return h(
    'details',
    { className: 'json', onclick: (event: MouseEvent) => event.stopPropagation() },
    h('summary', {}, h('code', { className: 'muted' }, preview(value, 40))),
    h(
      'ul',
      {},
      entries.map(([key, item]) => h('li', {}, h('code', { className: 'json-key' }, `${key}: `), jsonView(item))),
    ),
  );
}

/** An event's kind (`set`, `add`, `subtract`) and the value it carried. */
function eventParts(event: GoblinEvent): { kind: string; value: unknown } {
  const key = [':set', ':add', ':subtract'].find((k) => k in event) ?? ':set';
  return { kind: key.slice(1), value: event[key] };
}

/** The event's source document — a link to the line behind it when the
 * engine knows one (overrides and hand-built trees have none). */
function eventOrigin(event: GoblinEvent): HTMLElement {
  const source = event[':source'] as string | undefined;
  const line = event[':line'] as number | undefined;
  if (source === undefined || line === undefined) return sourceChip(source);
  const column = (event[':column'] as number | undefined) ?? 1;
  return h(
    'button',
    {
      type: 'button',
      className: 'source located',
      style: sourceStyle(source),
      title: `Open ${source} at line ${line}`,
      onclick: (click: MouseEvent) => {
        click.stopPropagation();
        void openSource(source, line, column);
      },
    },
    `${source}:${line}`,
  );
}

async function openSource(file: string, line: number, column: number): Promise<void> {
  state.viewing = { file, line, column };
  render();
  if (!sources.has(file)) {
    const query = new URLSearchParams({ entry: state.entry, file });
    const response = await fetch(`/api/source?${query}`);
    sources.set(file, response.ok ? await response.text() : `# could not load ${file}: ${await response.text()}`);
    render();
  }
  document.querySelector('.viewer .hit')?.scrollIntoView({ block: 'center' });
}

function closeSource(): void {
  state.viewing = undefined;
  render();
}

/** The cited document with its line marked, beside the sheet. */
function renderViewer(): HTMLElement | null {
  const view = state.viewing;
  if (!view) return null;
  const text = sources.get(view.file);
  return h(
    'aside',
    { className: 'viewer', 'aria-label': `${view.file} source` },
    h(
      'header',
      {},
      h('span', { className: 'source', style: sourceStyle(view.file) }, view.file),
      h('code', { className: 'muted' }, `line ${view.line}, column ${view.column}`),
      h('button', { type: 'button', className: 'ghost', onclick: closeSource }, 'Close'),
    ),
    text === undefined
      ? h('p', { className: 'muted' }, 'Loading…')
      : h(
          'ol',
          { className: 'code' },
          text
            .split('\n')
            .map((content, i) =>
              h(
                'li',
                { className: i + 1 === view.line ? 'hit' : '' },
                h('span', { className: 'ln' }, String(i + 1)),
                h('code', {}, content || ' '),
              ),
            ),
        ),
  );
}

// -- choices and overrides, kept per entry for the browser session ------------

type Kept = 'choices' | 'overrides';
const keptKey = (kind: Kept, entry: string) => `goblin:${kind}:${entry}`;

/** Storage can be blocked (private windows, previews): values then last only
 * as long as the page. */
function load(kind: Kept, entry: string): Record<string, unknown> {
  try {
    const stored = sessionStorage.getItem(keptKey(kind, entry));
    return stored ? (JSON.parse(stored) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function save(kind: Kept, values: Record<string, unknown>): void {
  try {
    if (Object.keys(values).length === 0) sessionStorage.removeItem(keptKey(kind, state.entry));
    else sessionStorage.setItem(keptKey(kind, state.entry), JSON.stringify(values));
  } catch {
    /* not persisted — the page still works */
  }
}

function loadEntry(entry: string): void {
  state.entry = entry;
  state.params = load('choices', entry);
  state.overrides = load('overrides', entry);
}

/** An override's text as `--set` reads it: JSON, else a plain string. */
function parseOverride(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// -- resolution ---------------------------------------------------------------

async function resolve(): Promise<void> {
  save('choices', state.params);
  save('overrides', state.overrides);
  $('status').textContent = 'Resolving…';
  const response = await fetch('/api/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entry: state.entry, params: state.params, overrides: state.overrides }),
  });
  state.result = (await response.json()) as Resolution;
  $('status').textContent = '';
  if (state.result.nodes && !state.result.nodes.some((node) => node.path === state.selected)) state.selected = '';
  render();
}

// -- rendering ----------------------------------------------------------------

function render(): void {
  renderChoices();
  const main = $('main');
  const result = state.result;
  if (!result) return;
  const parts: Child[] = [
    result.failure
      ? h('div', { className: 'notice bad' }, h('strong', {}, 'Could not resolve: '), result.failure)
      : null,
    result.errors ? renderErrors(result.errors) : null,
    result.query ? renderQuery(result.query) : null,
    result.nodes ? renderSheet(result.nodes) : null,
    renderViewer(),
  ];
  main.replaceChildren(...parts.filter((part): part is Node | string => Boolean(part)));
}

function renderChoices(): void {
  for (const [section, list, values] of [
    ['choices', 'choice-list', state.params],
    ['overrides', 'override-list', state.overrides],
  ] as const) {
    const entries = Object.entries(values);
    $(section).hidden = entries.length === 0;
    $(list).replaceChildren(
      ...entries.map(([path, value]) =>
        h(
          'span',
          { className: `chip${section === 'overrides' ? ' forced' : ''}` },
          h('code', {}, path),
          ' = ',
          preview(value, 32),
          h(
            'button',
            {
              type: 'button',
              className: 'chip-x',
              title: `Forget ${path}`,
              onclick: () => {
                delete values[path];
                void resolve();
              },
            },
            '×',
          ),
        ),
      ),
    );
  }
}

/** Force this field's value, as `--set` does; it wins over everything else. */
function renderOverride(node: InspectNode): HTMLElement {
  const forced = node.path in state.overrides;
  const input = h('textarea', {
    className: 'override-input',
    rows: 2,
    spellcheck: false,
    value: JSON.stringify(forced ? state.overrides[node.path] : (node.value ?? null)),
  });
  const apply = (event: SubmitEvent) => {
    event.preventDefault();
    state.overrides[node.path] = parseOverride(input.value.trim());
    void resolve();
  };
  return h(
    'form',
    { className: 'override', onsubmit: apply },
    input,
    h(
      'div',
      { className: 'override-actions' },
      h('button', { type: 'submit' }, forced ? 'Update override' : 'Override'),
      forced
        ? h(
            'button',
            {
              type: 'button',
              className: 'ghost',
              onclick: () => {
                delete state.overrides[node.path];
                void resolve();
              },
            },
            'Remove',
          )
        : null,
      h('span', { className: 'note' }, 'JSON, else text. Beats choices, patches and expressions.'),
    ),
  );
}

function renderErrors(errors: string[]): HTMLElement {
  return h(
    'div',
    { className: 'notice bad' },
    h('strong', {}, 'The sheet breaks its own rules'),
    h(
      'ul',
      {},
      errors.map((error) => h('li', {}, h('code', {}, error))),
    ),
  );
}

/** One control per outstanding param; submitting adds them to the choices. */
function renderQuery(query: MissingParam[]): HTMLElement {
  const readers: (() => unknown)[] = [];
  const cards = query.map((param) => {
    const [control, read] = paramControl(param);
    readers.push(read);
    return h(
      'fieldset',
      { className: 'card' },
      h('legend', {}, param.label ?? param.path),
      h('code', { className: 'muted' }, param.path),
      param.doc ? h('p', { className: 'doc' }, param.doc) : null,
      control,
    );
  });
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    query.forEach((param, i) => {
      const value = readers[i]?.();
      if (value !== undefined) state.params[param.path] = value;
    });
    void resolve();
  };
  return h(
    'form',
    { className: 'query', onsubmit: submit },
    h('h2', {}, 'The engine needs a few choices'),
    h('div', { className: 'cards' }, cards),
    h('button', { type: 'submit' }, 'Continue'),
  );
}

function paramControl(param: MissingParam): [HTMLElement, () => unknown] {
  const options = param.options;
  if (options && param.type === 'array') {
    // Exact-count picks may repeat (the same ability twice), so one select each.
    const count = param.count ?? options.length;
    const selects = Array.from({ length: count }, () => optionSelect(options));
    const read = () => {
      const picks = selects.map((select) => (select.value === '' ? undefined : options[Number(select.value)]));
      return picks.every((pick) => pick !== undefined) ? picks : undefined;
    };
    return [h('div', { className: 'picks' }, selects), read];
  }
  if (options) {
    const select = optionSelect(options);
    return [select, () => (select.value === '' ? undefined : options[Number(select.value)])];
  }
  if (param.type === 'boolean') {
    const box = h('input', { type: 'checkbox' });
    return [h('label', { className: 'inline' }, box, ' yes'), () => box.checked];
  }
  const numeric = param.type === 'integer' || param.type === 'number';
  const input = h('input', {
    type: numeric ? 'number' : 'text',
    min: param.min,
    max: param.max,
    step: param.type === 'integer' ? 1 : undefined,
    placeholder: param.type === 'array' || param.type === 'record' ? 'JSON' : (param.type ?? 'value'),
  });
  const read = () => {
    if (input.value === '') return undefined;
    if (numeric) return Number(input.value);
    if (param.type === 'array' || param.type === 'record') return JSON.parse(input.value);
    return input.value;
  };
  return [input, read];
}

function optionSelect(options: unknown[]): HTMLSelectElement {
  return h(
    'select',
    {},
    h('option', { value: '' }, 'choose…'),
    options.map((option, i) => h('option', { value: String(i) }, preview(option))),
  );
}

// -- the resolved sheet -------------------------------------------------------

/** Read paths may be patterns (`resources.*.max`, `resources.{…}.current`). */
function matcher(read: string): (path: string) => boolean {
  if (!/\*|\{/.test(read)) return (path) => path === read;
  const pattern = read
    .replace(/\{[^}]*\}/g, '*')
    .split('.')
    .map((segment) => (segment === '*' ? '[^.]+' : segment.replace(/[$()+?^|\\[\]]/g, '\\$&')))
    .join('\\.');
  const regex = new RegExp(`^${pattern}$`);
  return (path) => regex.test(path);
}

function readIndex(nodes: InspectNode[]): Map<string, string[]> {
  const readBy = new Map<string, string[]>();
  for (const node of nodes) {
    for (const read of node.reads) {
      if (read.startsWith('$')) continue;
      const matches = matcher(read);
      for (const target of nodes) {
        if (!matches(target.path)) continue;
        readBy.set(target.path, [...(readBy.get(target.path) ?? []), node.path]);
      }
    }
  }
  return readBy;
}

function renderSheet(nodes: InspectNode[]): HTMLElement {
  const byPath = new Map(nodes.map((node) => [node.path, node]));
  const readBy = readIndex(nodes);
  const select = (path: string) => {
    state.selected = path;
    // Reveal it: open every collapsed ancestor.
    const parts = path.split('.');
    for (let i = 0; i <= parts.length; i++) state.collapsed.delete(parts.slice(0, i).join('.'));
    render();
    document.querySelector('.tree .row.selected')?.scrollIntoView({ block: 'nearest' });
  };
  return h(
    'div',
    { className: 'sheet' },
    renderTree(nodes, select),
    renderDetail(byPath.get(state.selected) ?? nodes[0], nodes, byPath, readBy, select),
    renderStream(nodes, select),
  );
}

function renderTree(nodes: InspectNode[], select: (path: string) => void): HTMLElement {
  const filter = state.filter.toLowerCase();
  const hidden = (path: string) => {
    const parts = path.split('.');
    for (let i = 0; i < parts.length; i++) {
      if (state.collapsed.has(parts.slice(0, i).join('.')) && path !== '') return true;
    }
    return false;
  };
  const rows = nodes
    .filter((node) => (filter ? node.path.toLowerCase().includes(filter) : !hidden(node.path)))
    .map((node) => {
      const depth = node.path === '' ? 0 : node.path.split('.').length;
      const open = !state.collapsed.has(node.path);
      const branch = node.children.length > 0;
      return h(
        'div',
        {
          className: `row${node.path === state.selected ? ' selected' : ''}`,
          style: `--depth: ${filter ? 0 : depth}`,
          onclick: () => select(node.path),
        },
        h(
          'span',
          {
            className: 'twist',
            onclick: (event: MouseEvent) => {
              if (!branch) return;
              event.stopPropagation();
              if (open) state.collapsed.add(node.path);
              else state.collapsed.delete(node.path);
              render();
            },
          },
          branch ? (open ? '▾' : '▸') : '',
        ),
        h(
          'span',
          { className: `key${node.private ? ' private' : ''}` },
          filter ? node.path || '(app)' : node.key || '(app)',
        ),
        kindBadge(node),
        node.path in state.overrides ? h('span', { className: 'kind forced' }, 'override') : null,
        node.kind !== 'record' && node.kind !== 'list' && node.kind !== 'function'
          ? h('span', { className: 'val' }, preview(node.value, 28))
          : null,
        node.events ? h('span', { className: 'count', title: 'events' }, String(node.events.length)) : null,
      );
    });
  return h(
    'section',
    { className: 'panel tree' },
    h('h2', {}, 'Fields'),
    h('input', {
      type: 'search',
      placeholder: 'Filter by path',
      value: state.filter,
      oninput: (event: InputEvent) => {
        state.filter = (event.target as HTMLInputElement).value;
        render();
        const input = document.querySelector<HTMLInputElement>('.tree input[type=search]');
        input?.focus();
        input?.setSelectionRange(state.filter.length, state.filter.length);
      },
    }),
    h('div', { className: 'rows' }, rows),
  );
}

/** A node's kind, or the actor it declares (`Character`, or `Character(aria)` when namespaced). */
function kindBadge(node: InspectNode): HTMLElement {
  if (node.actor) {
    const name = node.namespace ? `${node.actor}(${node.namespace})` : node.actor;
    return h('span', { className: 'kind actor', title: `$actor: ${node.actor}` }, name);
  }
  return h('span', { className: `kind ${node.kind}` }, node.kind);
}

function pathLink(
  path: string,
  byPath: Map<string, InspectNode>,
  select: (path: string) => void,
  label = path || '(app)',
): HTMLElement {
  if (!byPath.has(path)) return h('code', { className: 'muted' }, label);
  return h('button', { type: 'button', className: 'link', onclick: () => select(path) }, label);
}

function renderReads(
  reads: string[],
  nodes: InspectNode[],
  byPath: Map<string, InspectNode>,
  select: (path: string) => void,
): HTMLElement {
  return h(
    'ul',
    { className: 'refs' },
    reads.map((read) => {
      if (read.startsWith('$'))
        return h('li', {}, h('code', { className: 'muted' }, read), h('span', { className: 'note' }, ' app'));
      if (!/\*|\{/.test(read)) return h('li', {}, pathLink(read, byPath, select));
      const matches = nodes.filter((node) => matcher(read)(node.path));
      return h(
        'li',
        {},
        h('code', {}, read),
        h('span', { className: 'note' }, ` ${matches.length} match${matches.length === 1 ? '' : 'es'}`),
        h(
          'ul',
          { className: 'refs nested' },
          matches.map((match) => h('li', {}, pathLink(match.path, byPath, select))),
        ),
      );
    }),
  );
}

function renderDetail(
  node: InspectNode | undefined,
  nodes: InspectNode[],
  byPath: Map<string, InspectNode>,
  readBy: Map<string, string[]>,
  select: (path: string) => void,
): HTMLElement {
  if (!node) return h('section', { className: 'panel detail' });
  const parts = node.path ? node.path.split('.') : [];
  const crumbs = [
    pathLink('', byPath, select),
    ...parts.flatMap((part, i) => [' . ', pathLink(parts.slice(0, i + 1).join('.'), byPath, select, part)]),
  ];
  const readers = readBy.get(node.path) ?? [];
  const section = (title: string, body: Child | Child[]) => h('div', { className: 'block' }, h('h3', {}, title), body);
  return h(
    'section',
    { className: 'panel detail' },
    h('div', { className: 'crumbs' }, crumbs),
    h(
      'h2',
      {},
      node.label ?? (node.key || 'App'),
      ' ',
      kindBadge(node),
      node.path in state.overrides ? h('span', { className: 'kind forced' }, 'override') : null,
      node.private ? h('span', { className: 'kind private' }, 'private') : null,
    ),
    node.doc ? h('p', { className: 'doc' }, node.doc) : null,
    node.kind === 'record' || node.kind === 'list'
      ? section(
          'Children',
          h(
            'ul',
            { className: 'refs' },
            node.children.map((child) =>
              h('li', {}, pathLink(node.path ? `${node.path}.${child}` : child, byPath, select)),
            ),
          ),
        )
      : section('Value', h('pre', { className: 'value' }, JSON.stringify(node.value, null, 2) ?? 'undefined')),
    node.expression ? section('Expression', h('pre', { className: 'expr' }, node.expression)) : null,
    node.kind !== 'function' && node.path !== '' ? section('Override', renderOverride(node)) : null,
    node.param ? section('Choice', h('pre', { className: 'value' }, JSON.stringify(node.param, null, 2))) : null,
    node.rules
      ? section(
          'Rules',
          h(
            'ul',
            { className: 'refs' },
            node.rules.map((rule) => h('li', {}, h('code', {}, rule))),
          ),
        )
      : null,
    node.reads.length ? section('Reads', renderReads(node.reads, nodes, byPath, select)) : null,
    readers.length
      ? section(
          'Read by',
          h(
            'ul',
            { className: 'refs' },
            [...new Set(readers)].map((path) => h('li', {}, pathLink(path, byPath, select))),
          ),
        )
      : null,
    section(
      'Events',
      node.events
        ? h(
            'ol',
            { className: 'timeline' },
            node.events.map((event) => {
              const { kind, value } = eventParts(event);
              return h('li', {}, eventOrigin(event), h('span', { className: `op ${kind}` }, kind), jsonView(value));
            }),
          )
        : h('p', { className: 'muted' }, 'No writes: this field holds what its document declared.'),
    ),
  );
}

/** Every event on the sheet, filterable by the document that made it. */
function renderStream(nodes: InspectNode[], select: (path: string) => void): HTMLElement {
  const rows = nodes.flatMap((node) =>
    (node.events ?? []).map((event, step) => ({
      node,
      event,
      step,
      source: (event[':source'] as string) ?? 'unnamed',
    })),
  );
  const sources = [...new Set(rows.map((row) => row.source))];
  const shown = state.source ? rows.filter((row) => row.source === state.source) : rows;
  const pick = (source: string) => () => {
    state.source = state.source === source ? '' : source;
    render();
  };
  return h(
    'section',
    { className: 'panel stream' },
    h('h2', {}, 'Event stream ', h('span', { className: 'note' }, `${shown.length} of ${rows.length}`)),
    h(
      'div',
      { className: 'chips' },
      sources.map((source) =>
        h(
          'button',
          {
            type: 'button',
            className: `source pick${state.source === source ? ' on' : ''}`,
            style: sourceStyle(source),
            onclick: pick(source),
          },
          source,
        ),
      ),
    ),
    h('p', { className: 'note' }, 'Ordered per field; a global order arrives with history.'),
    h(
      'ol',
      { className: 'events' },
      shown.map(({ node, event, step }) => {
        const { kind, value } = eventParts(event);
        return h(
          'li',
          { onclick: () => select(node.path), className: node.path === state.selected ? 'selected' : '' },
          eventOrigin(event),
          h('span', { className: `op ${kind}` }, kind),
          h('code', { className: 'path' }, `${node.path}#${step + 1}`),
          jsonView(value),
        );
      }),
    ),
  );
}

// -- boot ---------------------------------------------------------------------

async function boot(): Promise<void> {
  const entries = (await (await fetch('/api/entries')).json()) as string[];
  const picker = $<HTMLSelectElement>('entry');
  picker.replaceChildren(...entries.map((entry) => h('option', { value: entry }, entry)));
  state.entry = entries.includes('5e/main.yaml') ? '5e/main.yaml' : (entries[0] ?? '');
  picker.value = state.entry;
  loadEntry(state.entry);
  picker.addEventListener('change', () => {
    loadEntry(picker.value);
    state.selected = '';
    state.collapsed.clear();
    void resolve();
  });
  $('resolve').addEventListener('click', () => void resolve());
  document.addEventListener('keydown', (key) => {
    if (key.key === 'Escape' && state.viewing) closeSource();
  });
  $('reset').addEventListener('click', () => {
    state.params = {};
    void resolve();
  });
  await resolve();
}

void boot();
