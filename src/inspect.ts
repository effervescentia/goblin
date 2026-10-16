/**
 * Flatten a resolved actor into inspectable nodes: every field with its
 * printed value, the expression behind it, the fields it reads, and the
 * `:events` that produced it. Pure — the UI server feeds it the merged raw
 * actor and the `{ data }` the engine printed for it.
 */
import {
  ACTOR_KEY,
  ASSIGN_OP,
  DOC_KEY,
  EVENTS_KEY,
  IF_KEY,
  LABEL_KEY,
  PARAM_KEY,
  PARAM_VALUE_KEY,
  THEN_KEY,
  VALIDATE_KEY,
} from './constants';
import { Die } from './nodes/die';
import { ExpressionNode } from './nodes/expression';
import { FunctionNode } from './nodes/function';
import { RecordNode } from './nodes/record';
import { isBareSigil, isMetaKey, isPathKey, isPrivateKey, isValidateKey } from './utils';

export type InspectKind = 'record' | 'list' | 'param' | 'expression' | 'function' | 'value';

export interface InspectNode {
  /** Dotted path from the entry root; `''` is the root itself. */
  path: string;
  key: string;
  kind: InspectKind;
  /** The actor a record declares (`$actor: Character`). */
  actor?: string;
  /** That actor's namespace, when its `$tmpl` gave it one. */
  namespace?: string;
  /** Printed value, without its `:events` wrapper (absent on records and lists). */
  value?: unknown;
  /** Expression or function body as written. */
  expression?: string;
  label?: string;
  doc?: string;
  /** `:param` declaration metadata (`:type`, `:options`, …). */
  param?: Record<string, unknown>;
  /** `!validate` rules declared on this record. */
  rules?: string[];
  events?: Record<string, unknown>[];
  /** Absolute paths (`$.…` for the app root) this node's expression reads. */
  reads: string[];
  children: string[];
  private: boolean;
}

/** Fields of a raw record that are data, in document order. */
function fieldKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter(
    (key) =>
      !isMetaKey(key) &&
      !isValidateKey(key) &&
      !isBareSigil(key) &&
      !isPathKey(key) &&
      key !== ACTOR_KEY &&
      key !== IF_KEY &&
      key !== THEN_KEY,
  );
}

const join = (parent: string, key: string) => (parent ? `${parent}.${key}` : key);

/** A ref as an absolute path: `.x` from the holding record, `@`/`#` from the
 * actor root (they coincide once patches are merged), `$` kept as written. */
function absolute(ref: string, holder: string): string {
  if (ref.startsWith('$')) return ref;
  if (ref.startsWith('@') || ref.startsWith('#')) return ref.replace(/^[@#]\.?/, '');
  return join(holder, ref.slice(1));
}

/** Refs a function body reads. On the right of a wildcard assignment `.` is
 * each match's record, so those refs hang off the target's pattern. */
function bodyReads(body: string, holder: string): string[] {
  const reads = body.split(/\r?\n|;/).flatMap((statement) => {
    const at = statement.search(ASSIGN_OP);
    const target =
      at >= 0
        ? statement
            .slice(0, at)
            .replace(/[+-]\s*$/, '')
            .trim()
        : '';
    if (!/\.\*|\.\{/.test(target)) return FunctionNode.detectDeps(statement).map((ref) => absolute(ref, holder));
    const pattern = absolute(target, holder);
    const owner = pattern.slice(0, pattern.lastIndexOf('.'));
    return [pattern, ...FunctionNode.detectDeps(statement.slice(at + 1)).map((ref) => absolute(ref, owner))];
  });
  return [...new Set(reads)];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Die)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Split a printed node into its value and the events attached to it. */
function unwrap(printed: unknown): { value: unknown; events?: Record<string, unknown>[] } {
  const record = asRecord(printed);
  const events = record?.[EVENTS_KEY] as Record<string, unknown>[] | undefined;
  if (record && PARAM_VALUE_KEY in record && !(PARAM_KEY in record)) return { value: record[PARAM_VALUE_KEY], events };
  return { value: printed, events };
}

/** `namespaceOf` is the engine's (`engine.namespaceOf`): namespaces live on
 * the resolved tree's records, not in its data. */
export function inspect(
  actor: unknown,
  data: unknown,
  namespaceOf?: (record: object) => string | undefined,
): InspectNode[] {
  const nodes: InspectNode[] = [];
  const visit = (raw: unknown, printed: unknown, path: string, key: string, holder: string) => {
    const { value, events } = unwrap(printed);
    const node: InspectNode = { path, key, kind: 'value', reads: [], children: [], private: isPrivateKey(key) };
    nodes.push(node); // before its children, so the list reads in document order
    if (events) node.events = events;
    const record = asRecord(raw);
    // Annotated so it stays a plain boolean: as a guard, its false branch
    // would narrow `record` away.
    const isParam: boolean = record !== undefined && RecordNode.isParam(record);
    if (record && isParam) {
      node.kind = 'param';
      node.param = Object.fromEntries(
        Object.entries(record).filter(([k]) => isMetaKey(k) && k !== LABEL_KEY && k !== DOC_KEY),
      );
      node.value = asRecord(value)?.[PARAM_VALUE_KEY] ?? null;
    } else if (record) {
      node.kind = 'record';
      const rules = record[VALIDATE_KEY];
      if (Array.isArray(rules)) node.rules = rules.map(String);
      const out = asRecord(value) ?? {};
      for (const child of fieldKeys(record)) {
        const fn = FunctionNode.match(child, record[child], record);
        const name = fn ? fn.name : child.replace(/^\+/, '');
        node.children.push(name);
        if (fn) {
          const body = typeof fn.body === 'string' ? fn.body : JSON.stringify(fn.body);
          nodes.push({
            path: join(path, name),
            key: name,
            kind: 'function',
            expression: `(${fn.params.join(', ')}) => ${body.trim()}`,
            reads: typeof fn.body === 'string' ? bodyReads(fn.body, path) : [],
            children: [],
            private: isPrivateKey(name),
          });
          continue;
        }
        visit(record[child], out[name], join(path, name), name, path);
      }
    } else if (Array.isArray(raw)) {
      node.kind = 'list';
      const out = Array.isArray(value) ? value : [];
      raw.forEach((item, index) => {
        node.children.push(String(index));
        // List items read relative to the record holding the list.
        visit(item, out[index], join(path, String(index)), String(index), holder);
      });
    } else {
      node.value = value;
      if (typeof raw === 'string' && ExpressionNode.matches(raw)) {
        node.kind = 'expression';
        node.expression = raw;
        node.reads = FunctionNode.detectDeps(raw).map((ref) => absolute(ref, holder));
      }
    }
    if (record) {
      if (typeof record[ACTOR_KEY] === 'string') node.actor = record[ACTOR_KEY] as string;
      const namespace = namespaceOf?.(record);
      if (namespace !== undefined) node.namespace = namespace;
      if (typeof record[LABEL_KEY] === 'string') node.label = record[LABEL_KEY] as string;
      if (typeof record[DOC_KEY] === 'string') node.doc = record[DOC_KEY] as string;
    }
  };
  visit(actor, data, '', '', '');
  return nodes;
}
