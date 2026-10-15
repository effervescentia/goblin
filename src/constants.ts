/**
 * Goblin — every magic string and pattern the engine recognizes, in one
 * place. Predicates and behavior built on these live in `./utils`.
 */

// -- addressibility sigils (see SYNTAX.md) ------------------------------------

/** Current node. */
export const CURRENT = '.';
/** Document root. */
export const DOCUMENT = '#';
/** Actor root. */
export const ACTOR = '@';
/** App root. */
export const APP = '$';

/** Actor type tag key (`$: Character`); `#:` would be a YAML comment. */
export const TYPE_TAG = '$';

export type Sigil = typeof CURRENT | typeof DOCUMENT | typeof ACTOR | typeof APP;

/** Path segment matching every child (`@.resources.*.max`). */
export const WILDCARD = '*';

// -- expression patterns -------------------------------------------------

/** Dice literal: `dN` / `NdM`. */
export const DIE_LITERAL = /^(\d*)d(\d+)$/;

// NOTE: `[#$@]` below spells DOCUMENT + ACTOR + APP (`.` is matched
// separately); keep in sync if sigils change.
/** Sigil references (`.x`, `#.x`, `@.x`, `$.x`, `$lib.x`, bare sigils). Global: reset `lastIndex` around `.test`/`.match`. */
export const SIGIL_REF =
  /([$]lib(\.[A-Za-z_][\w.]*)?|[#$@]\.[A-Za-z_][\w.]*|[#$@](?![\w.]|\.\w)|\.[A-Za-z_][\w.]*|\.(?![\w.]))/g;

/** Inline dice inside larger expressions. */
export const INLINE_DICE = /\b(\d*)d(\d+)\b/g;

/** Function-definition keys: `name()` / `name(p1, p2)`. */
export const FUNCTION_KEY = /^([A-Za-z_]\w*)\(([^)]*)\)$/;

/** Single `=` assignment (excludes `==`, `>=`, `<=`, `!=`). */
export const ASSIGN_OP = /(?<![<>=!])=(?![>=])/;

/** Dot-less sigils (`@abilities` → `@.abilities`); replacement is `'$1.'`. */
export const DOTLESS_SIGIL = /([#$@])(?=[A-Za-z_])/g;

/** Quoted string literals, protected from ref/dice rewriting. */
export const STRING_LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;

/** Whole-string call to a definition: `$tmpl('x.yaml')`, `$.feature.y()`. */
export const CALL_EXPR = /^[#$@.][\w.]*\([^()]*\)$/;

/** Whole-string template call: `$tmpl('file.yaml')`. */
export const TEMPLATE_CALL = /^\$tmpl\(\s*['"]([^'"]+)['"]\s*\)$/;

/** Template references anywhere in file text (discovery scan). */
export const TEMPLATE_SCAN = /\$(?:tmpl|mixin)\(\s*['"]([^'"]+)['"]\s*\)/g;

/** `$mixin('file.yaml')`: merge an actor-typed document into the actor of
 * the nearest document up the template chain declaring the same `$` type. */
export const MIXIN_CALL = /^\$mixin\(\s*['"]([^'"]+)['"]\s*\)$/;

// -- recognized keys -------------------------------------------------------

/** Prefix for metadata attached to the containing node (`:doc`, …). */
export const META_PREFIX = ':';

/** Marks a node whose value the user must provide. */
export const PARAM_KEY = ':param';

/** Documentation attached to a node; never evaluated. */
export const DOC_KEY = ':doc';

/** Human-readable display name for a node (UI label); never evaluated. */
export const LABEL_KEY = ':label';

/** Declares a `:param` node's expected type. */
export const TYPE_KEY = ':type';

/** Default filled when a `:param` has no provided value. */
export const DEFAULT_KEY = ':default';

/** Allowed values for a `:param` (scalar must equal one; array items each must). */
export const OPTIONS_KEY = ':options';

/** Exact item count required of an array `:param` value. */
export const COUNT_KEY = ':count';

/** Inclusive numeric bounds for a `:param` value (array items each checked). */
export const MIN_KEY = ':min';
export const MAX_KEY = ':max';

/** When `true`, array `:param` items must be distinct. */
export const UNIQUE_KEY = ':unique';

/** Predicate list applied to the containing node. */
export const VALIDATE_KEY = '!validate';

/** Condition gating a patch node (missing/empty counts as unconditional). */
export const IF_KEY = '$if';

/** Absolute patch applied when `$if` holds. */
export const THEN_KEY = '$then';

/** Slot holding a `:param` node's filled value. */
export const VALUE_KEY = 'value';

/** Filled value shown on an evaluated `:param` record (display only). */
export const PARAM_VALUE_KEY = ':value';

// -- change events ---------------------------------------------------------

/** A written field's change history: `{ :value, :events }` (see `apply`). */
export const EVENTS_KEY = ':events';

/** Event: the value a patch wrote over the field. */
export const SET_KEY = ':set';

/** Event `:source` for a value written by `applyOverrides` (CLI `--set`). */
export const OVERRIDE_SOURCE = 'override';

/** Event: the items a patch appended to an array field. */
export const ADD_KEY = ':add';
/** Event: the amount a `-=` assignment took from a field. */
export const SUBTRACT_KEY = ':subtract';
/** Event: where in its `:source` document the write was made (1-based). */
export const LINE_KEY = ':line';
export const COLUMN_KEY = ':column';

/** Debug function descriptor keys (see `FunctionNode.debug`). */
export const PARAMS_KEY = ':params';
export const SOURCE_KEY = ':source';
export const DEPS_KEY = ':deps';
