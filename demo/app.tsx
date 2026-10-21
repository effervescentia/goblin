/// <reference lib="dom" />
/**
 * Character sheet demo: resolves `aria` from `5e/main.yaml` over a WebSocket
 * `goblin/client`, asks for each missing param with a form, and binds the
 * resolved fields to a sheet. The server is stateful, so each turn sends only
 * its new inputs and a reload picks up where the session left off.
 */
import type { ComponentChildren } from 'preact';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Answer, ResolveParams } from '@/client/dtos';
import { createClient, type GoblinClient } from '@/client/main';
import type { MissingParam } from '@/nodes/record';
import {
  at,
  CHARACTER,
  ENTRY,
  fields,
  formulaAt,
  humanize,
  labelOf,
  readParam,
  signed,
  slotsOf,
  unwrap,
} from './sheet';

type Input = NonNullable<ResolveParams['inputs']>[number];

type Turn = (inputs?: Input[]) => void;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function App() {
  const client = useRef<GoblinClient>(undefined);
  const busy = useRef(false);
  const [answer, setAnswer] = useState<Answer>();
  const [status, setStatus] = useState('connecting…');

  const turn: Turn = async (inputs = []) => {
    if (!client.current || busy.current) return;
    busy.current = true;
    setStatus('resolving…');
    try {
      setAnswer(await client.current.resolve({ entry: ENTRY, inputs }));
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
        ) : (
          <Sheet sheet={at(answer.data, CHARACTER)} turn={turn} />
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
      <h2>Choices to make</h2>
      <div class="cards">
        {query.map((param) => (
          <fieldset key={param.path} class="card">
            <legend>{param.label ?? humanize(param.path.split('.').at(-1) ?? param.path)}</legend>
            {param.doc ? <p class="doc">{param.doc}</p> : null}
            <div class="picks">
              {Array.from({ length: slotsOf(param) }, (_, slot) => (
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

function Stat({
  label,
  formula,
  children,
}: {
  label: string;
  formula?: { formula: string; parts: string[] };
  children: ComponentChildren;
}) {
  return (
    <div class="stat" title={formula?.parts.join(', ')}>
      <span class="value">{children}</span>
      <span>{label}</span>
      {formula ? <span class="formula">{formula.formula}</span> : null}
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

function Sheet({ sheet, turn }: { sheet: unknown; turn: Turn }) {
  const get = (path: string) => at(sheet, path);
  const invoke = (path: string) => () => turn([{ type: 'invoke', path: `${CHARACTER}.${path}`, value: [] }]);
  const saves = (get('proficiencies.saving_throws') as string[] | undefined) ?? [];

  return (
    <article class="sheet">
      <header class="identity">
        <h2>{String(get('name'))}</h2>
        <p>
          Level {String(get('level'))} {humanize(String(get('species')))} {humanize(String(get('class')))} ·{' '}
          {String(get('xp'))} XP
        </p>
      </header>

      <div class="stats">
        <Stat label="Armor Class" formula={formulaAt(sheet, 'armor_class')}>
          {String(get('armor_class'))}
        </Stat>
        <Stat label="Hit Points">
          {String(get('hit_points.current'))} / {String(get('hit_points.max'))}
        </Stat>
        <Stat label="Initiative">{signed(get('initiative.base'))}</Stat>
        <Stat label="Speed">{String(get('speed'))} ft</Stat>
        <Stat label="Proficiency">{signed(get('proficiency_bonus'))}</Stat>
        <Stat label="Hit Die">{String(get('hit_die'))}</Stat>
        <Stat label="Attacks">{String(get('attacks'))}</Stat>
        <Stat label="Critical Hit">{String(get('critical_hit'))}–20</Stat>
      </div>

      <div class="abilities">
        {fields(get('abilities')).map(([name, ability]) => (
          <div key={name} class="ability">
            <span class="name">{humanize(name)}</span>
            <span class="modifier">{signed(at(ability, 'modifier'))}</span>
            <span class="score">{String(at(ability, 'base'))}</span>
            {saves.includes(name) ? <span class="save">saving throw</span> : null}
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
              <span>{labelOf(resource, name)}</span>
              <span class="muted">
                {String(at(resource, 'current'))} / {String(at(resource, 'max'))}
              </span>
              <span class="muted">{String(at(resource, 'recover'))} rest</span>
            </div>
          ))}
        </Section>

        <Section title="Actions">
          {fields(get('actions')).map(([name, action]) => {
            const type = at(action, 'type');
            return (
              <div key={name} class="action">
                <span>{labelOf(action, name)}</span>
                <span class="muted">
                  {[type && humanize(String(type)), at(action, 'die')].filter(Boolean).join(' · ')}
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
          <h3>Armor</h3>
          <Tags items={get('proficiencies.armor')} />
          <h3>Weapons</h3>
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
                  {labelOf(feature, name)}
                  {typeof choice === 'string' ? `: ${humanize(choice)}` : null}
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

render(<App />, document.getElementById('app') as HTMLElement);
