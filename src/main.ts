import { YAML } from 'bun';
import pino from 'pino';
import { GoblinEngine } from './engine';
import { serialize } from './nodes/serialize';

const debug = process.argv.includes('--debug');
const log = pino({
  level: debug ? 'debug' : 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, singleLine: false },
  },
});

const goblinOpts = await Bun.file('.goblin.yaml')
  .text()
  .then((t: string) => YAML.parse(t) as { root: string; main: string });

const engine = new GoblinEngine(goblinOpts.root);
await engine.loadFile(goblinOpts.main);

const evaluated = engine.evaluateDoc(goblinOpts.main);
log.info({ doc: serialize(evaluated) }, 'evaluated main.yaml');

// Apply the monk class (level 1) onto a fresh actor built from main.yaml.
const actorRaw = structuredClone(engine.docs.get(goblinOpts.main));
if (engine.docs.has('monk2.yaml')) {
  engine.apply(actorRaw, 'monk2.yaml');
  const scope = { doc: actorRaw, actor: actorRaw, app: engine.appRoot, current: actorRaw };
  const withMonk = engine.evaluate(actorRaw, scope);
  log.info({ actor: serialize(withMonk) }, 'actor + monk level 1');

  const failures = engine.validate(withMonk);
  if (failures.length) {
    log.error({ failures }, '!validate failures');
  } else {
    log.debug('!validate: all passing');
  }

  // Demonstrate a callable + dice: initiative roll and a short rest.
  // (rest.* assigns through `#`, the app root, so re-evaluate to see it.)
  type View = Record<string, unknown>;
  const rec = withMonk as View;
  const initiative = rec.initiative as { roll?: () => unknown };
  const actions = rec.actions as { unarmed_strike?: { die?: unknown } };
  const rest = rec.rest as { short?: () => unknown };
  log.debug({ roll: initiative?.roll?.() }, 'initiative.roll()');
  log.debug({ die: String(actions?.unarmed_strike?.die) }, 'unarmed_strike die');
  log.debug({ armor_class: rec.armor_class }, 'armor_class');
  rest?.short?.();
  const refreshed = engine.evaluate(actorRaw, scope) as View;
  const appView = engine.evaluate(engine.appRoot, {
    doc: actorRaw,
    actor: actorRaw,
    app: engine.appRoot,
    current: engine.appRoot,
  }) as View;
  log.debug(
    {
      app_hit_points: (appView?.hit_points as View)?.value,
      actor_hit_points: (refreshed.hit_points as View)?.value,
    },
    'after short rest',
  );
}
