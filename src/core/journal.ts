/**
 * The engine's history of one run: every write filed per field (the
 * printed `:events`), every write and roll in the order made (the stream
 * events), and the roll tape a replayed stream re-rolls from.
 */

import { match } from 'ts-pattern';
import {
  ADD_KEY,
  COLUMN_KEY,
  EVENTS_KEY,
  LABEL_KEY,
  LINE_KEY,
  PARAM_VALUE_KEY,
  SET_KEY,
  SOURCE_KEY,
  SUBTRACT_KEY,
  TEMPLATE_CALL,
  VERSION_KEY,
} from '@/constants';
import {
  type InputEvent,
  isRollEvent,
  isWriteEvent,
  type Part,
  parseDice,
  type RollEvent,
  type StateEvent,
  type WriteEvent,
} from '@/inputs';
import { Die, type RollFrame } from '@/nodes/die';
import { debug } from '@/nodes/serialize';
import { deepClone, getChild, sameValue } from '@/utils';
import type { Location } from './locations';
import type { Provenance } from './provenance';

/** A write as the engine logged it (see `record`). */
interface LoggedWrite {
  /** Order made, among writes and rolls. */
  seq: number;
  record: object;
  key: string;
  kind: string;
  event: Record<string, unknown>;
  /** The invoke whose call assigned it. */
  cause?: InputEvent;
  /** The latest invoke to start before it was made. */
  phase?: InputEvent;
  rolled: boolean;
  calculation?: Calculation;
  /** The recorded write whose value it reused. */
  replayed?: WriteEvent;
}

/** A roll on the tape: recorded by a replayed stream, or rolled here. */
interface Roll {
  count: number;
  sides: number;
  faces: number[];
  /** The run that first rolled it, when a replayed stream recorded it. */
  version?: number;
  /** Already in this run's log (a field re-evaluated reads it again). */
  logged?: boolean;
  /** The labelled expression that last used it. */
  calculation?: Calculation;
}

/** A labelled expression being evaluated: its `formula`, and the `{ :label, :value }` parts its tags have
 * evaluated so far (filled in as it runs, so a roll ahead of a tag still sees it). */
export interface Calculation {
  formula: string;
  parts: Record<string, unknown>[];
}

/** A roll as the engine logged it, the first time this run used it. */
interface LoggedRoll {
  seq: number;
  path: string;
  roll: Roll;
  /** The invoke whose call rolled it, outside any field. */
  cause?: InputEvent;
  phase?: InputEvent;
}

/** A logged write or roll as a stream event, with where it belongs in the stream. */
export interface EngineEvent {
  cause?: InputEvent;
  phase?: InputEvent;
  /** The recorded version, when a replayed stream already held this event. */
  version?: number;
  event: Omit<WriteEvent, 'version'> | Omit<RollEvent, 'version'>;
}

/** Dice rolled and dice already credited to an inner field, at some moment. */
export interface RollMark {
  rolled: number;
  attributed: number;
}

/** Who a write is filed under; anything left out comes from the write in progress. */
export interface WriteOptions {
  source?: string;
  origin?: string;
  at?: Location;
  cause?: InputEvent;
  rolled?: boolean;
  /** The labelled expression an assignment wrote; patch writes have none. */
  calculation?: Calculation;
}

/** `calculation` as stream event fields, each part's value serialized like `data`. */
function calculationFields(calculation: Calculation | undefined): { formula?: string; parts?: Part[] } {
  if (calculation === undefined) return {};
  const parts = calculation.parts.map((part) => ({
    label: String(part[LABEL_KEY]),
    value: debug(part[PARAM_VALUE_KEY]),
  }));
  return { formula: calculation.formula, parts };
}

function writeType(kind: string): WriteEvent['type'] {
  return kind === ADD_KEY ? 'add' : kind === SUBTRACT_KEY ? 'subtract' : 'set';
}

/** One `{ :source?, :line?, :column?, :set | :add | :subtract }` entry. */
function entry(
  source: string | undefined,
  kind: string,
  value: unknown,
  at: Location | undefined,
  version?: number,
): Record<string, unknown> {
  return {
    ...(source === undefined ? {} : { [SOURCE_KEY]: source }),
    ...(version === undefined ? {} : { [VERSION_KEY]: version }),
    ...(at === undefined ? {} : { [LINE_KEY]: at.line, [COLUMN_KEY]: at.column }),
    [kind]: value,
  };
}

export class Journal {
  /** Patch writes per field, keyed by the record holding the field. */
  private readonly fieldEvents = new WeakMap<object, Map<string, unknown[]>>();
  /** Every patch and assignment write in the order made. */
  private readonly writeLog: LoggedWrite[] = [];
  /** Every roll, the first time this run used it. */
  private readonly rollLog: LoggedRoll[] = [];
  /** Order of writes and rolls together. */
  private seq = 0;
  /** Rolls by context (`field:<path>` or `invoke:<version>:<path>`), nth in its place. */
  private tape = new Map<string, Roll[]>();
  /** The invoke event whose call is running, if any. */
  private invoking: InputEvent | undefined;
  /** The latest invoke to start: writes made since follow it in the stream. */
  private phase: InputEvent | undefined;
  /** Writes a replayed stream recorded: an invoke's keep their values. */
  private recorded: WriteEvent[] = [];
  /** The tree being resolved, which write paths run from. */
  private entryRoot: unknown;
  /** Rolls already credited to an inner field, so an outer one only counts its own. */
  private attributedRolls = 0;
  /** Expression fields whose own evaluation rolled dice. */
  private readonly rolledFields = new WeakMap<object, Set<string>>();
  /** Location of the patch key being applied; events cite it. */
  private writingAt: Location | undefined;
  /** Source names for the apply in progress (the patch, and the actor under it). */
  private applySource: string | undefined;
  private actorSource: string | undefined;
  /** The innermost expression being evaluated, when it is labelled. */
  private calculating: Calculation | undefined;

  constructor(private readonly provenance: Provenance) {}

  /**
   * Start resolving `entryRoot` against a stream. Recorded writes are not
   * replayed as such — the inputs make them again — but recorded rolls are,
   * so every die lands as it did. Returns the frame for rolls outside any field.
   */
  begin(entryRoot: unknown, events: StateEvent[], inputs: InputEvent[]): RollFrame {
    this.recorded = events.filter(isWriteEvent);
    this.tape = new Map();
    for (const roll of events.filter(isRollEvent)) {
      const invoked = inputs.some((e) => e.type === 'invoke' && e.version === roll.version && e.path === roll.path);
      const context = invoked ? `invoke:${roll.version}:${roll.path}` : `field:${roll.path}`;
      const [count = 0, sides = 0] = parseDice(roll.dice) ?? [];
      const rolls = this.tape.get(context) ?? [];
      rolls.push({ count, sides, faces: roll.value, version: roll.version });
      this.tape.set(context, rolls);
    }
    this.entryRoot = entryRoot;
    this.phase = undefined;
    // Rolls outside any field (a `$if`, say) take their turn in one run-wide context.
    let n = 0;
    return { roll: (count, sides) => this.tapeRoll('field:', '', n++, count, sides) };
  }

  /** The invoke event whose call is running, if any. */
  get cause(): InputEvent | undefined {
    return this.invoking;
  }

  /** Run `call` as `event`'s: its assignments cite it, its rolls take its tape. */
  invoke<T>(event: InputEvent, call: () => T): T {
    const outer = this.invoking;
    this.invoking = event;
    this.phase = event;
    let n = 0;
    const frame: RollFrame = {
      roll: (count, sides) =>
        this.tapeRoll(`invoke:${event.version}:${event.path}`, event.path, n++, count, sides, event),
    };
    try {
      return Die.within(frame, call);
    } finally {
      this.invoking = outer;
    }
  }

  /** The labelled expression being evaluated, if the innermost one is. */
  get calculation(): Calculation | undefined {
    return this.calculating;
  }

  /** Run one expression's evaluation: rolls it makes cite `calculation` (none, for an unlabelled one). */
  calculate<T>(calculation: Calculation | undefined, evaluate: () => T): T {
    const outer = this.calculating;
    this.calculating = calculation;
    try {
      return evaluate();
    } finally {
      this.calculating = outer;
    }
  }

  /** Run `write` with the event sources it should file writes under. */
  asSource(source: string | undefined, actorRaw: unknown, write: () => void): void {
    const outerPatch = this.applySource;
    const outerActor = this.actorSource;
    this.applySource = source;
    this.actorSource = this.provenance.sourceOf(actorRaw);
    try {
      write();
    } finally {
      this.applySource = outerPatch;
      this.actorSource = outerActor;
    }
  }

  /** Run `write` with events citing `record[key]`'s location — or the
   * enclosing one, for keys with none (e.g. a call's copied body). */
  writing(record: object, key: string, write: () => void): void {
    const at = this.provenance.locationOf(record, key);
    if (at === undefined) {
      write();
      return;
    }
    const outer = this.writingAt;
    this.writingAt = at;
    try {
      write();
    } finally {
      this.writingAt = outer;
    }
  }

  /** Note a patch write, in application order. Call before writing. Returns
   * the value to write: a replayed invoke's recorded value in place of `value`. */
  record(
    target: Record<string, unknown>,
    key: string,
    kind: string,
    value: unknown,
    options: WriteOptions = {},
  ): unknown {
    const {
      source = this.applySource,
      origin = this.actorSource,
      at = this.writingAt,
      cause,
      rolled = false,
      calculation,
    } = options;
    const event = entry(source, kind, value, at);
    this.seed(target, key, origin).push(event);
    const logged: LoggedWrite = {
      seq: this.seq++,
      record: target,
      key,
      kind,
      event,
      cause,
      phase: this.phase,
      rolled,
      calculation,
    };
    this.writeLog.push(logged);
    const replayed = cause !== undefined && this.recorded.length > 0 && this.replayInvokeWrite(logged);
    return replayed ? deepClone(logged.event[kind]) : value;
  }

  /** File an override's `:set`, citing the input's `version`. */
  override(target: Record<string, unknown>, key: string, value: unknown, version?: number): void {
    this.seed(target, key).push(entry(this.applySource, SET_KEY, value, this.writingAt, version));
  }

  /** Open a field's log, recording what it already holds as the first event.
   * Call before mutating in place, so that origin is the prior value. */
  seed(target: Record<string, unknown>, key: string, origin = this.actorSource): unknown[] {
    let fields = this.fieldEvents.get(target);
    if (fields === undefined) {
      fields = new Map();
      this.fieldEvents.set(target, fields);
    }
    let log = fields.get(key);
    if (log === undefined) {
      log =
        key in target ? [entry(origin, SET_KEY, deepClone(target[key]), this.provenance.locationOf(target, key))] : [];
      fields.set(key, log);
    }
    return log;
  }

  /** The writes that produced `record[key]`, or undefined when untouched. */
  eventsFor(record: object, key: string): unknown[] | undefined {
    const log = this.fieldEvents.get(record)?.get(key);
    return log && log.length > 0 ? log : undefined;
  }

  /** The latest write filed for `record[key]`, if any. */
  lastWrite(record: object, key: string): Record<string, unknown> | undefined {
    return this.fieldEvents.get(record)?.get(key)?.at(-1) as Record<string, unknown> | undefined;
  }

  mark(): RollMark {
    return { rolled: Die.rolled, attributed: this.attributedRolls };
  }

  /** Whether dice rolled since `mark`, outside any inner field's own evaluation. */
  rolledSince(mark: RollMark): boolean {
    return Die.rolled - mark.rolled > this.attributedRolls - mark.attributed;
  }

  /** Run one evaluation of `record[key]` in its own roll context, noting
   * whether it rolled. */
  evaluating<T>(record: object, key: string, evaluate: () => T): T {
    const mark = this.mark();
    try {
      return Die.within(this.fieldFrame(record, key), evaluate);
    } finally {
      if (this.rolledSince(mark)) {
        const keys = this.rolledFields.get(record) ?? new Set();
        keys.add(key);
        this.rolledFields.set(record, keys);
      }
      // Everything rolled in here now belongs to this field, as far as outer ones can tell.
      this.attributedRolls = mark.attributed + (Die.rolled - mark.rolled);
    }
  }

  /** Where `cause`'s call wrote an actor in (`#.combat = $tmpl(…)`): each
   * path from the entry root, with the namespace the call gave it. */
  writtenActors(cause: InputEvent): { path: string; namespace?: string }[] {
    const paths = this.treePaths();
    return this.writeLog.flatMap(({ record, key, kind, event, cause: by }) => {
      const call = event[kind];
      const at = paths.get(record);
      const tmpl = typeof call === 'string' ? call.trim().match(TEMPLATE_CALL) : null;
      if (by !== cause || kind !== SET_KEY || tmpl === null || at === undefined) return [];
      return [{ path: [...at, key].join('.'), namespace: tmpl[2] }];
    });
  }

  /** Drop the field rolls recorded under `path` before `version`: they
   * belong to whatever an actor written in there since replaced. */
  forgetRolls(path: string, version: number): void {
    for (const [context, rolls] of this.tape) {
      const at = context.slice('field:'.length);
      if (!context.startsWith('field:') || (at !== path && !at.startsWith(`${path}.`))) continue;
      this.tape.set(
        context,
        rolls.filter((roll) => roll.version === undefined || roll.version >= version),
      );
    }
  }

  /** The nth roll in `context`: the tape's faces, when it holds the same
   * dice there, else a fresh roll that joins it. Logged the first time used. */
  private tapeRoll(
    context: string,
    path: string,
    n: number,
    count: number,
    sides: number,
    cause?: InputEvent,
  ): number[] {
    const rolls = this.tape.get(context) ?? [];
    this.tape.set(context, rolls);
    let roll = rolls[n];
    if (roll === undefined || roll.count !== count || roll.sides !== sides) {
      roll = { count, sides, faces: Die.fresh(count, sides) };
      rolls[n] = roll;
    }
    // A field re-evaluated rolls again from its latest evaluation's parts.
    roll.calculation = this.calculating;
    if (!roll.logged) {
      roll.logged = true;
      this.rollLog.push({ seq: this.seq++, path, roll, cause, phase: this.phase });
    }
    return [...roll.faces];
  }

  /** The roll context of one evaluation of `record[key]`: rolls count from 0
   * each time, so a field rolls the same however often it is evaluated. A
   * field outside the entry tree rolls in its caller's context. */
  private fieldFrame(record: object, key: string): RollFrame {
    const outer = Die.current();
    let n = 0;
    return {
      roll: (count, sides) => {
        const at = this.treePaths().get(record);
        if (at === undefined) return outer === undefined ? Die.fresh(count, sides) : outer.roll(count, sides);
        const path = [...at, key].join('.');
        return this.tapeRoll(`field:${path}`, path, n++, count, sides);
      },
    };
  }

  /** Paths from `root` (the entry by default) to every record and list in it. */
  private treePaths(root = this.entryRoot): Map<object, string[]> {
    const paths = new Map<object, string[]>();
    const visit = (node: unknown, path: string[]) => {
      if (node === null || typeof node !== 'object' || node instanceof Die || paths.has(node)) return;
      paths.set(node, path);
      for (const [key, child] of Object.entries(node)) visit(child, [...path, key]);
    };
    visit(root, []);
    return paths;
  }

  /** The recorded write in the same place as `entry`: the nth write of its
   * kind to its path here pairs with the nth recorded one. */
  private recordedFor(entry: LoggedWrite, paths: Map<object, string[]>): WriteEvent | undefined {
    const at = paths.get(entry.record);
    if (at === undefined) return undefined;
    const path = [...at, entry.key].join('.');
    const type = writeType(entry.kind);
    let nth = 0;
    for (const other of this.writeLog) {
      if (other === entry) break;
      const where = paths.get(other.record);
      if (where !== undefined && other.kind === entry.kind && [...where, other.key].join('.') === path) nth++;
    }
    return this.recorded.filter((event) => event.type === type && event.path === path)[nth];
  }

  /** Swap an invoked call's write for its recorded twin's value: what a call
   * did is history (a rest heals to the max it had then, not the max a later
   * level-up gives). */
  private replayInvokeWrite(entry: LoggedWrite): boolean {
    const recorded = this.recordedFor(entry, this.treePaths());
    if (recorded === undefined) return false;
    entry.event[entry.kind] = deepClone(recorded.value);
    entry.replayed = recorded;
    return true;
  }

  /**
   * The logged writes that landed in `root` and every die rolled, in the
   * order made, as stream events. Write values read back from `data`
   * (`root`'s `debug` output), so they match the printed `:events`. Each
   * keeps the invoke that caused it, the invoke it followed (`phase`), and
   * the recorded version when a replayed stream already held it.
   */
  events(root: unknown, data: unknown): EngineEvent[] {
    const paths = this.treePaths(root);
    const printedAt = (path: string[]) => {
      let node = data as Record<string, unknown> | undefined;
      for (const seg of path) {
        if (node === null || typeof node !== 'object') return undefined;
        // A `{ :value, :events }` pair holds the field's children under `:value`.
        if (!(seg in node) && PARAM_VALUE_KEY in node) node = node[PARAM_VALUE_KEY] as Record<string, unknown>;
        node = getChild(node, seg) as Record<string, unknown> | undefined;
      }
      return node;
    };
    const writes = this.writeLog.flatMap((entry) => {
      const { seq, record, key, kind, event, cause, phase, calculation } = entry;
      const at = paths.get(record);
      const log = this.fieldEvents.get(record)?.get(key);
      const index = log?.indexOf(event) ?? -1;
      if (at === undefined || log === undefined || index < 0) return [];
      // Without `data` (an unresolved run) only an invoke's writes are kept:
      // assignments log resolved values, and the rest recompute on replay.
      const printed = match({ data, cause })
        .with({ data: undefined, cause: undefined }, () => undefined)
        .with({ data: undefined }, () => event)
        .otherwise(() => (printedAt([...at, key])?.[EVENTS_KEY] as Record<string, unknown>[] | undefined)?.[index]);
      if (printed === undefined) return [];
      const write: Omit<WriteEvent, 'version'> = {
        type: writeType(kind),
        path: [...at, key].join('.'),
        value: printed[kind],
      };
      // A field's latest `:set` prints as the field itself; earlier writes evaluate on their own.
      const rolled =
        entry.rolled ||
        (index === log.length - 1 && kind === SET_KEY
          ? this.rolledFields.get(record)?.has(key)
          : this.rolledFields.get(event)?.has(kind));
      if (rolled) write.rolled = true;
      Object.assign(write, calculationFields(calculation));
      if (typeof printed[SOURCE_KEY] === 'string') write.source = printed[SOURCE_KEY];
      if (typeof printed[LINE_KEY] === 'number') write.line = printed[LINE_KEY];
      if (typeof printed[COLUMN_KEY] === 'number') write.column = printed[COLUMN_KEY];
      const recorded = entry.replayed ?? this.recordedFor(entry, paths);
      const version = recorded !== undefined && sameValue(recorded.value, write.value) ? recorded.version : undefined;
      return [{ seq, cause, phase, version, event: write }];
    });
    const rolls = this.rollLog.map(({ seq, path, roll, cause, phase }) => ({
      seq,
      cause,
      phase,
      version: roll.version,
      event: {
        type: 'roll' as const,
        path,
        dice: `${roll.count}d${roll.sides}`,
        value: [...roll.faces],
        ...calculationFields(roll.calculation),
      },
    }));
    return [...writes, ...rolls].sort((a, b) => a.seq - b.seq).map(({ seq: _, ...rest }) => rest);
  }
}
