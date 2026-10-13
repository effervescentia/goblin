/**
 * Goblin — every magic string and pattern the engine recognizes, in one
 * place. Predicates and behavior built on these live in `./utils`.
 */

// -- addressibility sigils (see SYNTAX.md) ------------------------------------

/** Current node. */
export const CURRENT = '.';
/** Document root. */
export const DOCUMENT = '$';
/** Actor root. */
export const ACTOR = '@';
/** App root. */
export const APP = '#';

export type Sigil = typeof CURRENT | typeof DOCUMENT | typeof ACTOR | typeof APP;

// -- expression patterns -------------------------------------------------

/** Dice literal: `dN` / `NdM`. */
export const DIE_LITERAL = /^(\d*)d(\d+)$/;

// NOTE: `[#$@]` below spells DOCUMENT + ACTOR + APP (`.` is matched
// separately); keep in sync if sigils change.
/** Sigil references (`.x`, `$.x`, `@.x`, `#.x`, `$lib.x`, bare sigils). Global: reset `lastIndex` around `.test`/`.match`. */
export const SIGIL_REF = /([$]lib(\.[A-Za-z_][\w.]*)?|[#$@]\.[A-Za-z_][\w.]*|[#$@](?![\w.]|\.\w)|\.[A-Za-z_][\w.]*|\.(?![\w.]))/g;

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

/** Whole-string template call: `$tmpl('file.yaml')`. */
export const TEMPLATE_CALL = /^\$tmpl\(\s*['"]([^'"]+)['"]\s*\)$/;

/** Template references anywhere in file text (discovery scan). */
export const TEMPLATE_SCAN = /\$tmpl\(\s*['"]([^'"]+)['"]\s*\)/g;

// -- recognized keys -------------------------------------------------------

/** Prefix for metadata attached to the containing node (`:doc`, …). */
export const META_PREFIX = ':';

/** Marks a node whose value the user must provide. */
export const PARAM_KEY = ':param';

/** Documentation attached to a node; never evaluated. */
export const DOC_KEY = ':doc';

/** Declares a `:param` node's expected type. */
export const TYPE_KEY = ':type';

/** Default filled when a `:param` has no provided value. */
export const DEFAULT_KEY = ':default';

/** Allowed values for a `:param` (scalar must equal one; array items each must). */
export const OPTIONS_KEY = ':options';

/** Exact item count required of an array `:param` value. */
export const COUNT_KEY = ':count';

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

/** Printed function descriptor keys (see `serialize`). */
export const PARAMS_KEY = ':params';
export const SOURCE_KEY = ':source';
export const DEPS_KEY = ':deps';
