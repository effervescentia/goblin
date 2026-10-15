import {
  DEPS_KEY,
  DOTLESS_SIGIL,
  FUNCTION_KEY,
  META_PREFIX,
  PARAMS_KEY,
  SIGIL_REF,
  SOURCE_KEY,
  STRING_LITERAL,
  TYPE_KEY,
} from '../constants';
import type { GoblinEngine } from '../engine';
import type { EvalRoots } from '../utils';
import { deepClone, markWildcards } from '../utils';
import { ExpressionNode } from './expression';
import { Node } from './node';

/** Metadata attached to engine-created function closures for printing. */
export interface GoblinFunctionMeta {
  name: string;
  params: string[];
  /** The raw body string from the document. */
  source: string;
  /** Sigil refs the body resolves, in order of first appearance. */
  deps: string[];
}

/**
 * A `name()` / `name(params)` key. A string body is an expression evaluated
 * per call (`.` is the record holding it); a record body is a definition the
 * call hands back a fresh copy of.
 */
export class FunctionNode extends Node<unknown> {
  readonly name: string;
  readonly params: string[];

  constructor(
    key: string,
    readonly body: unknown,
    readonly record: Record<string, unknown>,
  ) {
    super(body);
    const match = key.match(FUNCTION_KEY)!;
    this.name = match[1]!;
    this.params = match[2]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Function-definition key: `name()` / `name(p1, p2)`. */
  static isKey(key: string): boolean {
    return FUNCTION_KEY.test(key);
  }

  static match(key: string, value: unknown, record: Record<string, unknown>): FunctionNode | null {
    const bodied = typeof value === 'string' || FunctionNode.isRecordBody(value);
    if (!bodied || !FunctionNode.isKey(key)) return null;
    return new FunctionNode(key, value, record);
  }

  /** A definition handed back whole, rather than an expression to evaluate. */
  static isRecordBody(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /** Sigil refs a body resolves, in order, outside string literals. */
  static detectDeps(body: string): string[] {
    // Literals hide from the scan but come back inside wildcard predicates.
    const literals: string[] = [];
    const bare = body.replace(STRING_LITERAL, (m) => `__STR${literals.push(m) - 1}__`).replace(DOTLESS_SIGIL, '$1.');
    const { code, unmark } = markWildcards(bare, literals);
    SIGIL_REF.lastIndex = 0;
    const matches = (code.match(SIGIL_REF) ?? []).map(unmark);
    SIGIL_REF.lastIndex = 0;
    // Omit $lib refs (stdlib is implicit).
    return [...new Set(matches)].filter((m) => !m.startsWith('$lib') && !m.startsWith('$.lib'));
  }

  /** Tag a closure with its document metadata. Survives as `$goblin`. */
  static tag(fn: (...args: unknown[]) => unknown, meta: GoblinFunctionMeta): (...args: unknown[]) => unknown {
    (fn as unknown as Record<string, unknown>).$goblin = meta;
    return fn;
  }

  /** Read back `$goblin` metadata, if present. */
  static metaOf(value: unknown): GoblinFunctionMeta | undefined {
    if (typeof value !== 'function') return undefined;
    const meta = (value as unknown as Record<string, unknown>).$goblin;
    return typeof meta === 'object' && meta !== null ? (meta as GoblinFunctionMeta) : undefined;
  }

  /** Printed form: the `$goblin` descriptor, or `[fn name()]` for natives. */
  static debug(fn: unknown): unknown {
    const meta = FunctionNode.metaOf(fn);
    if (meta) {
      return {
        [TYPE_KEY]: 'function',
        [PARAMS_KEY]: meta.params,
        [SOURCE_KEY]: meta.source.trim(),
        [DEPS_KEY]: meta.deps,
      };
    }
    const name = (fn as { name?: unknown }).name;
    return `[fn ${typeof name === 'string' && name ? name : 'anonymous'}()]`;
  }

  /** Plain output keeps user function bodies and native function labels. */
  static print(fn: unknown): unknown {
    const meta = FunctionNode.metaOf(fn);
    if (meta) return meta.source.trim();
    return FunctionNode.debug(fn);
  }

  override evaluate(engine: GoblinEngine, scope: EvalRoots): unknown {
    const body = this.body;
    if (FunctionNode.isRecordBody(body)) {
      // A fresh copy per call: two uses of one definition must not share
      // nodes, or a `:param` filled in one would show up in the other.
      const fn = (...args: unknown[]) =>
        engine.settle(bindParams(deepClone(body), this.params, args), scope.home ?? scope.doc);
      return FunctionNode.tag(fn, {
        name: this.name,
        params: this.params,
        source: JSON.stringify(body),
        deps: [],
      });
    }
    const text = String(body);
    const fnPath = [...(scope.path ?? []), this.name];
    const fn = (...args: unknown[]) => {
      const callParams = Object.fromEntries(this.params.map((p, i) => [p, args[i]]));
      return engine.evalExpr(text, { ...scope, current: this.record, params: callParams, path: fnPath });
    };
    return FunctionNode.tag(fn, {
      name: this.name,
      params: this.params,
      source: text,
      deps: FunctionNode.detectDeps(text),
    });
  }
}

/**
 * Bind a record body's parameters into the copy: each expression inside it
 * takes the argument as a literal, so the node reads as written once placed.
 * Metadata is left alone — prose is not an expression.
 */
function bindParams(node: unknown, params: string[], args: unknown[]): unknown {
  if (params.length === 0) return node;
  const bind = (value: unknown, inMeta: boolean): unknown => {
    if (Array.isArray(value)) return value.map((item) => bind(item, inMeta));
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const [key, entry] of Object.entries(record)) {
        record[key] = bind(entry, inMeta || key.startsWith(META_PREFIX));
      }
      return record;
    }
    if (typeof value !== 'string') return value;
    // `{param}` is the argument's text, in prose as much as anywhere else.
    const text = params.reduce((out, param, i) => out.replace(placeholder(param), String(args[i] ?? '')), value);
    if (inMeta || !ExpressionNode.matches(text)) return text;
    // In an expression, a bare parameter is the argument itself.
    return params.reduce((out, param, i) => out.replace(identifier(param), JSON.stringify(args[i] ?? null)), text);
  };
  return bind(node, false);
}

/** The parameter as a standalone token — never a `.segment` of a ref. */
function identifier(param: string): RegExp {
  return new RegExp(`(?<![\\w.$])${param}(?![\\w])`, 'g');
}

/** `{param}` — the spelling that reaches metadata, where prose lives. */
function placeholder(param: string): RegExp {
  return new RegExp(`\\{\\s*${param}\\s*\\}`, 'g');
}
