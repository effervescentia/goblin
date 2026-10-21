/// <reference lib="dom" />
/**
 * Character sheet demo: resolves `aria` from `5e/main.yaml` over a WebSocket
 * `goblin/client`, asks for each missing param with a form, and binds the
 * resolved fields to a sheet with a combat panel for the party. The server is stateful, so each turn sends only
 * its new inputs and a reload picks up where the session left off.
 */
import type { ComponentChildren } from 'preact';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { match, P } from 'ts-pattern';
import type { Answer, ResolveParams } from '@/client/dtos';
import { createClient, type GoblinClient } from '@/client/main';
import type { StateEvent } from '@/inputs';
import type { MissingParam } from '@/nodes/record';
import {
  at,
  CHARACTER,
  combatOf,
  describeEvent,
  docOf,
  ENTRY,
  eventsAt,
  expressionsOf,
  type FieldEvent,
  type Formula,
  fields,
  formulaAt,
  humanize,
  labelOf,
  picksAny,
  plainStep,
  readParam,
  type Segment,
  signed,
  slotsOf,
  solvedText,
  sourceOf,
  TEMPLATES,
  templateInputs,
  unwrap,
} from './sheet';

type Input = NonNullable<ResolveParams['inputs']>[number];

/** How many part colours `style.css` defines (`.hue-0` …); more labels than that reuse them. */
const HUES = 4;

type Turn = (inputs?: Input[]) => void;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A call to the function at `path` (full, from the root), with no arguments. */
const call = (path: string): Input => ({ type: 'invoke', path, value: [] });

function App() {
  const client = useRef<GoblinClient>(undefined);
  const busy = useRef(false);
  const [answer, setAnswer] = useState<Answer>();
  const [status, setStatus] = useState('connecting…');
  const [view, setView] = useState<'sheet' | 'json'>('sheet');
  const resolved = answer !== undefined && 'data' in answer;
  const [sessionID, setSessionID] = useState<string>();
  const [expressions, setExpressions] = useState(new Map<string, string>());

  const turn: Turn = async (inputs = []) => {
    if (!client.current || busy.current) return;
    busy.current = true;
    setStatus('resolving…');
    try {
      const next = await client.current.resolve({ entry: ENTRY, inputs });
      // A settled sheet's expressions are fetched before it shows, so its tooltips arrive with it.
      if ('data' in next) setExpressions(expressionsOf(await client.current.inspect({ entry: ENTRY }), CHARACTER));
      setAnswer(next);
      if (next.sessionID) setSessionID(next.sessionID);
      setStatus('');
    } catch (err) {
      setStatus(message(err));
    } finally {
      busy.current = false;
    }
  };

  // Connect once, on mount.
  useEffect(() => {
    (async () => {
      const { url } = (await (await fetch('/api/goblin')).json()) as { url: string };
      client.current = await createClient({ transport: 'websocket', url });
      await turn();
    })().catch((err) => setStatus(message(err)));
    return () => void client.current?.close();
  }, []);

  return (
    <>
      <header class="bar">
        <h1>Character Sheet</h1>
        <span class="status">{status}</span>
        {sessionID ? (
          <span class="session">
            session <code>{sessionID}</code>
          </span>
        ) : null}
        {resolved ? (
          <nav class="views">
            {(['sheet', 'json'] as const).map((name) => (
              <button
                key={name}
                type="button"
                class={view === name ? undefined : 'quiet'}
                aria-pressed={view === name}
                onClick={() => setView(name)}
              >
                {name === 'sheet' ? 'Sheet' : 'JSON'}
              </button>
            ))}
          </nav>
        ) : null}
      </header>
      <main>
        {answer === undefined ? null : 'errors' in answer ? (
          <ul class="errors">
            {answer.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : 'query' in answer ? (
          // Keyed by version so each turn's form starts blank.
          <Query key={answer.version} query={answer.query} turn={turn} />
        ) : view === 'json' ? (
          <Json actor={at(answer.data, CHARACTER)} />
        ) : (
          <Sheet data={answer.data} events={answer.events} expressions={expressions} turn={turn} />
        )}
      </main>
    </>
  );
}

// -- missing params -----------------------------------------------------------

function Query({ query, turn }: { query: MissingParam[]; turn: Turn }) {
  const [raw, setRaw] = useState<Record<string, string[]>>({});
  const set = (path: string, slot: number, value: string) =>
    setRaw((all) => {
      const slots = [...(all[path] ?? [])];
      slots[slot] = value;
      return { ...all, [path]: slots };
    });

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const inputs = query.flatMap((param): Input[] => {
      const value = readParam(param, raw[param.path] ?? []);
      return value === undefined ? [] : [{ type: 'parameter', path: param.path, value }];
    });
    if (inputs.length > 0) turn(inputs);
  };

  return (
    <form class="query" onSubmit={submit}>
      <div class="templates">
        <span class="muted">Start from a premade character:</span>
        {TEMPLATES.map((template) => (
          <button key={template.label} type="button" onClick={() => turn(templateInputs(template))}>
            {template.label}
          </button>
        ))}
      </div>
      <h2>Choices to make</h2>
      <div class="cards">
        {query.map((param) => (
          <fieldset key={param.path} class="card">
            <legend>{param.label ?? humanize(param.path.split('.').at(-1) ?? param.path)}</legend>
            {param.doc ? <p class="doc">{param.doc}</p> : null}
            <div class="picks">
              {picksAny(param)
                ? param.options?.map((option, i) => (
                    <label key={String(option)} class="check">
                      <input
                        type="checkbox"
                        checked={Boolean(raw[param.path]?.[i])}
                        onChange={(event) => set(param.path, i, event.currentTarget.checked ? '1' : '')}
                      />
                      {humanize(String(option))}
                    </label>
                  ))
                : Array.from({ length: slotsOf(param) }, (_, slot) => (
                    <Control
                      // biome-ignore lint/suspicious/noArrayIndexKey: slots are positional
                      key={slot}
                      param={param}
                      value={raw[param.path]?.[slot] ?? ''}
                      onChange={(value) => set(param.path, slot, value)}
                    />
                  ))}
            </div>
          </fieldset>
        ))}
      </div>
      <button type="submit">Continue</button>
    </form>
  );
}

/** One control for `param`: a select of its options (by index), else a text or number box. */
function Control({ param, value, onChange }: { param: MissingParam; value: string; onChange: (raw: string) => void }) {
  const change = (event: Event) => onChange((event.currentTarget as HTMLInputElement | HTMLSelectElement).value);
  if (param.options) {
    return (
      <select value={value} onChange={change}>
        <option value="">choose…</option>
        {param.options.map((option, i) => (
          <option key={String(option)} value={String(i)}>
            {humanize(String(option))}
          </option>
        ))}
      </select>
    );
  }
  if (param.type === 'integer' || param.type === 'number') {
    const step = param.type === 'integer' ? 1 : undefined;
    return <input type="number" min={param.min} max={param.max} step={step} value={value} onInput={change} />;
  }
  const json = param.type === 'array' || param.type === 'record';
  return <input type="text" placeholder={json ? 'JSON' : undefined} value={value} onInput={change} />;
}

// -- the sheet ----------------------------------------------------------------

/** A formula's segments, each label (or, `solved`, its value) marked in its part's hue. */
function Segments({ segments, solved = false }: { segments: Segment[]; solved?: boolean }) {
  return (
    <code>
      ={' '}
      {segments.map((segment, i) =>
        match(segment)
          .with({ text: P.string }, ({ text }) => text)
          .with({ ref: P.string }, ({ ref, value }) => (solved ? String(value) : ref))
          .with({ label: P.string }, ({ label, value, hue }) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
            <span key={i} class={`part hue-${hue % HUES}`}>
              {solved ? String(value) : label}
            </span>
          ))
          .exhaustive(),
      )}
    </code>
  );
}

/** The derivation's lines: the formula, it solved (labels as values), then the value it all comes to —
 * each left out when it would only repeat the line before. */
function Derivation({ formula, expression, value }: { formula?: Formula; expression?: string; value?: unknown }) {
  const written = formula?.formula ?? expression;
  if (written === undefined) return null;
  const solved = formula && solvedText(formula.segments);
  const final = value === undefined ? undefined : String(value);
  return (
    <span class="expression">
      {formula ? <Segments segments={formula.segments} /> : <code>= {expression}</code>}
      {solved === undefined ? null : <Segments segments={formula?.segments ?? []} solved />}
      {final === undefined || final === (solved ?? written) ? null : <code>= {final}</code>}
    </span>
  );
}

/** `children`, with a tooltip on hover or focus: their `path` on the character, how they are derived — a labelled
 * `formula` and it solved, else the raw `expression` — and the `events` that set or changed them. */
function History({
  path,
  events = [],
  formula,
  expression,
  value,
  title,
  children,
}: {
  /** Where the field sits, relative to the character. */
  path?: string;
  events?: FieldEvent[];
  formula?: Formula;
  expression?: string;
  /** What the derivation comes to, shown last. */
  value?: unknown;
  title?: string;
  children: ComponentChildren;
}) {
  if (events.length === 0 && formula === undefined && expression === undefined) return <>{children}</>;
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: focus shows the tooltip to keyboard users
    <span class="history" tabIndex={0}>
      {children}
      <span class="tooltip" role="tooltip">
        {path ? <code class="path">{path}</code> : null}
        <Derivation formula={formula} expression={expression} value={value} />
        {title && events.length > 0 ? <span class="title">{title}</span> : null}
        {events.length > 0 ? (
          <ol>
            {events.map((event, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: events are append-only
              <li key={i}>
                <span>{describeEvent(event)}</span>
                <span class="source">{sourceOf(event)}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </span>
    </span>
  );
}

function Stat({ label, formula, children }: { label: string; formula?: Formula; children: ComponentChildren }) {
  return (
    <div class="stat">
      <span class="value">{children}</span>
      <span>{label}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Tags({ items }: { items: unknown }) {
  if (!Array.isArray(items) || items.length === 0) return <p class="muted">None</p>;
  return (
    <ul class="tags">
      {items.map((item) => (
        <li key={String(item)}>{humanize(String(item))}</li>
      ))}
    </ul>
  );
}

/** The fight in progress, in initiative order, or a button to start one. */
function Combat({ data, events, turn }: { data: unknown; events: StateEvent[]; turn: Turn }) {
  const combat = combatOf(data, events);
  const invoke = (path: string) => () => turn([call(path)]);
  if (!combat) {
    return (
      <Section title="Combat">
        <div class="rests">
          <button type="button" onClick={invoke('game.start_combat')}>
            Start combat
          </button>
        </div>
      </Section>
    );
  }
  return (
    <Section title={`Combat · Round ${String(combat.round)}`}>
      <ol class="order">
        {combat.order.map(({ key, initiative, formula, events }) => (
          <li key={key} class={key === combat.current ? 'current' : undefined}>
            <span>{String(at(data, `party.${key}.name`) ?? humanize(key))}</span>
            <span class="muted">
              initiative{' '}
              <History path={`combat.initiative.${key}`} formula={formula} value={initiative} events={events}>
                {String(initiative)}
              </History>
            </span>
          </li>
        ))}
      </ol>
      <div class="rests">
        <button type="button" onClick={invoke('combat.end_turn')}>
          End turn
        </button>
        <button type="button" class="quiet" onClick={invoke('game.end_combat')}>
          End combat
        </button>
      </div>
    </Section>
  );
}

function Sheet({
  data,
  events,
  expressions,
  turn,
}: {
  data: unknown;
  events: StateEvent[];
  expressions: Map<string, string>;
  turn: Turn;
}) {
  const sheet = at(data, CHARACTER);
  const get = (path: string) => at(sheet, path);
  const eventsOf = (path: string) => eventsAt(sheet, path);
  const tip = (path: string) => ({
    path,
    events: eventsOf(path),
    formula: formulaAt(sheet, path),
    expression: expressions.get(path),
    value: get(path),
  });
  const invoke = (path: string) => () => turn([call(`${CHARACTER}.${path}`)]);
  const saves = (get('proficiencies.saving_throws') as string[] | undefined) ?? [];

  return (
    <article class="sheet">
      <header class="identity">
        <h2>{String(get('name'))}</h2>
        <p>
          Level <History {...tip('level')}>{String(get('level'))}</History> {humanize(String(get('species')))}{' '}
          {humanize(String(get('class')))} · {String(get('xp'))} XP
        </p>
      </header>

      <Combat data={data} events={events} turn={turn} />

      <div class="stats">
        <Stat label="Armor Class" formula={formulaAt(sheet, 'armor_class')}>
          <History {...tip('armor_class')}>{String(get('armor_class'))}</History>
        </Stat>
        <Stat label="Hit Points">
          <History {...tip('hit_points.current')}>{String(get('hit_points.current'))}</History> /{' '}
          <History {...tip('hit_points.max')}>{String(get('hit_points.max'))}</History>
        </Stat>
        <Stat label="Initiative">
          <History {...tip('initiative.base')}>{signed(get('initiative.base'))}</History>
        </Stat>
        <Stat label="Speed">
          <History {...tip('speed')}>{String(get('speed'))} ft</History>
        </Stat>
        <Stat label="Proficiency">
          <History {...tip('proficiency_bonus')}>{signed(get('proficiency_bonus'))}</History>
        </Stat>
        <Stat label="Hit Die">
          <History {...tip('hit_die')}>{String(get('hit_die'))}</History>
        </Stat>
        <Stat label="Attacks">
          <History {...tip('attacks')}>{String(get('attacks'))}</History>
        </Stat>
        <Stat label="Critical Hit">
          <History {...tip('critical_hit')}>{get('critical_hit') === 20 ? '20' : `${get('critical_hit')}–20`}</History>
        </Stat>
      </div>

      <div class="abilities">
        {fields(get('abilities')).map(([name, ability]) => (
          <div key={name} class="ability">
            <span class="name">{humanize(name)}</span>
            <span class="modifier">
              <History {...tip(`abilities.${name}.modifier`)}>{signed(at(ability, 'modifier'))}</History>
            </span>
            <History
              path={`abilities.${name}.base`}
              formula={formulaAt(sheet, `abilities.${name}.base`)}
              expression={expressions.get(`abilities.${name}.base`)}
              value={at(ability, 'base')}
              events={eventsOf(`abilities.${name}.start`)}
              title="Starting score"
            >
              <span class="score">{String(at(ability, 'base'))}</span>
            </History>
            {saves.includes(name) ? (
              <History {...tip('proficiencies.saving_throws')}>
                <span class="save">saving throw</span>
              </History>
            ) : null}
          </div>
        ))}
      </div>

      <div class="columns">
        <Section title="Resources">
          <div class="rests">
            <button type="button" onClick={invoke('rest.short')}>
              Short rest
            </button>
            <button type="button" onClick={invoke('rest.long')}>
              Long rest
            </button>
          </div>
          {fields(get('resources')).map(([name, resource]) => (
            <div key={name} class="resource">
              <History {...tip(`resources.${name}`)}>{labelOf(resource, name)}</History>
              <span class="muted">
                <History {...tip(`resources.${name}.current`)}>{String(at(resource, 'current'))}</History> /{' '}
                <History {...tip(`resources.${name}.max`)}>{String(at(resource, 'max'))}</History>
              </span>
              <span class="muted">
                <History {...tip(`resources.${name}.recover`)}>{String(at(resource, 'recover'))} rest</History>
              </span>
            </div>
          ))}
        </Section>

        <Section title="Actions">
          {fields(get('actions')).map(([name, action]) => {
            const type = at(action, 'type');
            return (
              <div key={name} class="action">
                <History {...tip(`actions.${name}`)}>{labelOf(action, name)}</History>
                <span class="muted">
                  <History
                    path={`actions.${name}.die`}
                    events={[...eventsOf(`actions.${name}.type`), ...eventsOf(`actions.${name}.die`)]}
                  >
                    {[type && humanize(String(type)), at(action, 'die')].filter(Boolean).join(' · ')}
                  </History>
                </span>
                {fields(action).some(([key]) => key === 'use') ? (
                  <button type="button" onClick={invoke(`actions.${name}.use`)}>
                    Use
                  </button>
                ) : null}
              </div>
            );
          })}
        </Section>

        <Section title="Proficiencies">
          <h3>Skills</h3>
          <Tags items={get('skills.trained')} />
          <h3>
            <History {...tip('proficiencies.armor')}>Armor</History>
          </h3>
          <Tags items={get('proficiencies.armor')} />
          <h3>
            <History {...tip('proficiencies.weapon')}>Weapons</History>
          </h3>
          <Tags items={get('proficiencies.weapon')} />
        </Section>
      </div>

      <Section title="Features">
        <dl class="features">
          {fields(get('features')).map(([name, feature]) => {
            const choice = unwrap(feature);
            return (
              <div key={name}>
                <dt>
                  <History {...tip(`features.${name}`)}>
                    {labelOf(feature, name)}
                    {typeof choice === 'string' ? `: ${humanize(choice)}` : null}
                  </History>
                </dt>
                <dd>{at(feature, ':doc') as string | undefined}</dd>
              </div>
            );
          })}
        </dl>
      </Section>
    </article>
  );
}

// -- the actor as JSON ---------------------------------------------------------

/** The resolved actor behind the sheet: plain values, or as the engine sends it, metadata and all. */
function Json({ actor }: { actor: unknown }) {
  const [metadata, setMetadata] = useState(false);
  // Expanding or collapsing everything remounts the tree, since each node's `open` is the DOM's after a click.
  const [fold, setFold] = useState({ depth: 2, generation: 0 });
  const unfold = (depth: number) => setFold(({ generation }) => ({ depth, generation: generation + 1 }));
  return (
    <section class="panel json">
      <div class="json-tools">
        <label class="check">
          <input type="checkbox" checked={metadata} onChange={(event) => setMetadata(event.currentTarget.checked)} />
          Show metadata (<code>:value</code>, <code>:events</code>, <code>:formula</code>, …)
        </label>
        <button type="button" class="quiet" onClick={() => unfold(Number.POSITIVE_INFINITY)}>
          Expand all
        </button>
        <button type="button" class="quiet" onClick={() => unfold(1)}>
          Collapse all
        </button>
      </div>
      <div class="tree" key={fold.generation}>
        <JsonNode node={actor} metadata={metadata} depth={0} open={fold.depth} />
      </div>
    </section>
  );
}

interface JsonNodeProps {
  name?: string;
  node: unknown;
  metadata: boolean;
  depth: number;
  open: number;
}

/**
 * One value in the tree: a record or array folds open to its entries, opening by default above depth `open`.
 * Without `metadata`, the node shows as its plain value, with its `:doc` as a tooltip.
 */
function JsonNode({ name, node, metadata, depth, open }: JsonNodeProps) {
  const value = metadata ? node : plainStep(node);
  const doc = metadata ? undefined : docOf(node);
  const key = name === undefined ? null : <span class={doc ? 'key documented' : 'key'}>{JSON.stringify(name)}: </span>;
  if (value === null || typeof value !== 'object') {
    return (
      <div title={doc}>
        {key}
        <span class={`literal ${value === null ? 'null' : typeof value}`}>{JSON.stringify(value)}</span>
      </div>
    );
  }
  const list = Array.isArray(value);
  const entries: [string | undefined, unknown][] = list
    ? value.map((item) => [undefined, item])
    : Object.entries(value as Record<string, unknown>);
  const [start, end] = list ? ['[', ']'] : ['{', '}'];
  if (entries.length === 0) {
    return (
      <div title={doc}>
        {key}
        {start}
        {end}
      </div>
    );
  }
  return (
    <details open={depth < open}>
      <summary title={doc}>
        {key}
        {start}
        <span class="folded">
          … {end}{' '}
          <span class="muted">
            {entries.length} {list ? 'item' : 'key'}
            {entries.length === 1 ? '' : 's'}
          </span>
        </span>
      </summary>
      <div class="entries">
        {entries.map(([child, item], i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: entries are positional
          <JsonNode key={i} name={child} node={item} metadata={metadata} depth={depth + 1} open={open} />
        ))}
      </div>
      {end}
    </details>
  );
}

render(<App />, document.getElementById('app') as HTMLElement);
