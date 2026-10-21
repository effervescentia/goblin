/// <reference lib="dom" />
/**
 * Character sheet demo: resolves `aria` from `5e/main.yaml` over a WebSocket
 * `goblin/client`, asks for each missing param with a form, and binds the
 * resolved fields to a sheet. The server is stateful, so each turn sends only
 * its new inputs and a reload picks up where the session left off.
 */

import type { Answer, ResolveParams } from '@/client/dtos';
import { createClient, type GoblinClient } from '@/client/main';
import type { MissingParam } from '@/nodes/record';
import { at, CHARACTER, ENTRY, fields, humanize, labelOf, parseParam, signed, unwrap } from './sheet';

type Input = NonNullable<ResolveParams['inputs']>[number];

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
    else if (key in el) (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) el.append(child);
  }
  return el;
}

const main = document.getElementById('main') as HTMLElement;
const status = document.getElementById('status') as HTMLElement;

let client: GoblinClient;
let busy = false;

async function turn(inputs: Input[] = []): Promise<void> {
  if (busy) return;
  busy = true;
  status.textContent = 'resolving…';
  try {
    render(await client.resolve({ entry: ENTRY, inputs }));
    status.textContent = '';
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    busy = false;
  }
}

function render(answer: Answer): void {
  main.replaceChildren(
    'errors' in answer
      ? h(
          'ul',
          { className: 'errors' },
          answer.errors.map((error) => h('li', {}, error)),
        )
      : 'query' in answer
        ? renderQuery(answer.query)
        : renderSheet(at(answer.data, CHARACTER)),
  );
}

// -- missing params -----------------------------------------------------------

function renderQuery(query: MissingParam[]): HTMLElement {
  const controls = query.map(paramControl);
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const inputs = query.flatMap((param, i) => {
      const value = controls[i]?.[1]();
      return value === undefined ? [] : [{ type: 'parameter' as const, path: param.path, value }];
    });
    if (inputs.length > 0) void turn(inputs);
  };
  return h(
    'form',
    { className: 'query', onsubmit: submit },
    h('h2', {}, 'Choices to make'),
    h(
      'div',
      { className: 'cards' },
      query.map((param, i) =>
        h(
          'fieldset',
          { className: 'card' },
          h('legend', {}, param.label ?? humanize(param.path.split('.').at(-1) ?? param.path)),
          param.doc ? h('p', { className: 'doc' }, param.doc) : null,
          controls[i]?.[0],
        ),
      ),
    ),
    h('button', { type: 'submit' }, 'Continue'),
  );
}

/** A form control for `param` and a reader for its value, undefined until it is filled in. */
function paramControl(param: MissingParam): [HTMLElement, () => unknown] {
  const { options } = param;
  if (options && param.type === 'array') {
    // An exact count may repeat a pick (the same ability twice), so one select per pick.
    const selects = Array.from({ length: param.count ?? options.length }, () => optionSelect(options));
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
  const numeric = param.type === 'integer' || param.type === 'number';
  const input = h('input', {
    type: numeric ? 'number' : 'text',
    min: param.min,
    max: param.max,
    step: param.type === 'integer' ? 1 : undefined,
    placeholder: param.type === 'array' || param.type === 'record' ? 'JSON' : undefined,
  });
  return [input, () => parseParam(param, input.value)];
}

function optionSelect(options: unknown[]): HTMLSelectElement {
  return h(
    'select',
    {},
    h('option', { value: '' }, 'choose…'),
    options.map((option, i) => h('option', { value: String(i) }, humanize(String(option)))),
  );
}

// -- the sheet ----------------------------------------------------------------

const invoke = (path: string) => () => void turn([{ type: 'invoke', path: `${CHARACTER}.${path}`, value: [] }]);

function stat(label: string, value: Child): HTMLElement {
  return h('div', { className: 'stat' }, h('span', { className: 'value' }, value), h('span', {}, label));
}

function section(title: string, ...children: (Child | Child[])[]): HTMLElement {
  return h('section', { className: 'panel' }, h('h2', {}, title), ...children);
}

const list = (items: unknown) =>
  Array.isArray(items) && items.length > 0
    ? h(
        'ul',
        { className: 'tags' },
        items.map((item) => h('li', {}, humanize(String(item)))),
      )
    : h('p', { className: 'muted' }, 'None');

function renderSheet(sheet: unknown): HTMLElement {
  const get = (path: string) => at(sheet, path);
  const saves = (get('proficiencies.saving_throws') as string[] | undefined) ?? [];
  return h(
    'article',
    { className: 'sheet' },
    h(
      'header',
      { className: 'identity' },
      h('h2', {}, String(get('name'))),
      h(
        'p',
        {},
        `Level ${get('level')} ${humanize(String(get('species')))} ${humanize(String(get('class')))} · ${get('xp')} XP`,
      ),
    ),
    h(
      'div',
      { className: 'stats' },
      stat('Armor Class', String(get('armor_class'))),
      stat('Hit Points', `${get('hit_points.current')} / ${get('hit_points.max')}`),
      stat('Initiative', signed(get('initiative.base'))),
      stat('Speed', `${get('speed')} ft`),
      stat('Proficiency', signed(get('proficiency_bonus'))),
      stat('Hit Die', String(get('hit_die'))),
      stat('Attacks', String(get('attacks'))),
      stat('Critical Hit', `${get('critical_hit')}–20`),
    ),
    h(
      'div',
      { className: 'abilities' },
      fields(get('abilities')).map(([name, ability]) =>
        h(
          'div',
          { className: 'ability' },
          h('span', { className: 'name' }, humanize(name)),
          h('span', { className: 'modifier' }, signed(at(ability, 'modifier'))),
          h('span', { className: 'score' }, String(at(ability, 'base'))),
          saves.includes(name) ? h('span', { className: 'save' }, 'saving throw') : null,
        ),
      ),
    ),
    h(
      'div',
      { className: 'columns' },
      section(
        'Resources',
        h(
          'div',
          { className: 'rests' },
          h('button', { type: 'button', onclick: invoke('rest.short') }, 'Short rest'),
          h('button', { type: 'button', onclick: invoke('rest.long') }, 'Long rest'),
        ),
        fields(get('resources')).map(([name, resource]) =>
          h(
            'div',
            { className: 'resource' },
            h('span', {}, labelOf(resource, name)),
            h('span', { className: 'muted' }, `${at(resource, 'current')} / ${at(resource, 'max')}`),
            h('span', { className: 'muted' }, `${at(resource, 'recover')} rest`),
          ),
        ),
      ),
      section(
        'Actions',
        fields(get('actions')).map(([name, action]) => {
          const type = at(action, 'type');
          const die = at(action, 'die');
          return h(
            'div',
            { className: 'action' },
            h('span', {}, labelOf(action, name)),
            h('span', { className: 'muted' }, [type && humanize(String(type)), die].filter(Boolean).join(' · ')),
            fields(action).some(([key]) => key === 'use')
              ? h('button', { type: 'button', onclick: invoke(`actions.${name}.use`) }, 'Use')
              : null,
          );
        }),
      ),
      section(
        'Proficiencies',
        h('h3', {}, 'Skills'),
        list(get('skills.trained')),
        h('h3', {}, 'Armor'),
        list(get('proficiencies.armor')),
        h('h3', {}, 'Weapons'),
        list(get('proficiencies.weapon')),
      ),
    ),
    section(
      'Features',
      h(
        'dl',
        { className: 'features' },
        fields(get('features')).flatMap(([name, feature]) => {
          const choice = unwrap(feature);
          return [
            h('dt', {}, labelOf(feature, name), typeof choice === 'string' ? `: ${humanize(choice)}` : null),
            h('dd', {}, at(feature, ':doc') as string | undefined),
          ];
        }),
      ),
    ),
  );
}

try {
  const { url } = (await (await fetch('/api/goblin')).json()) as { url: string };
  client = await createClient({ transport: 'websocket', url });
  await turn();
} catch (err) {
  status.textContent = err instanceof Error ? err.message : String(err);
}
