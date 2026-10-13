# Goblin Syntax

Goblin documents are `.yaml` files evaluated by `src/engine.ts`. Each
`examples/NN-*.yaml` file demonstrates one section of this spec and is kept
runnable by `src/examples.test.ts`.

## Addressability

Nodes are referenced by path using a leading sigil that determines the root of the lookup.

| Sigil | Root | Description |
|-------|------|-------------|
| `.`   | Current node | Relative path from the node being evaluated |
| `$`   | Document root | Top of the current document (the `.yaml` file) |
| `@`   | Actor root | The actor instance this document is applied to |
| `#`   | App root | Global application namespace (shared tables, cross-doc values) |

Segments are separated by `.`. A bare sigil with no segments refers to the root itself.
The dot after a sigil is optional: `$foo.bar` and `$.foo.bar` are equivalent.

```yaml
# Examples (examples/01-addressability.yaml)
.base                          # sibling field 'base' on the current node
$.abilities.dexterity          # 'abilities.dexterity' from document root
@.features                     # 'features' on the actor this document is applied to
#.utils.ability_modifier       # 'ability_modifier' in the global utils namespace
```

In a document where the document itself defines the actor (e.g. `wip/player.yaml`), `$` and `@` resolve to the same root. The distinction matters in applied documents (e.g. class files like `wip/monk.yaml`) where `$` is the class document's own namespace and `@` is the character being modified.

Cross-namespace fallback: when a path is missing under `$` or `@`, the app
root is tried next (so `@.utils.…` works when the app supplies `utils`); a
missing `#` path falls back to the current document.

## Values: plain strings, expressions, dice

A scalar is evaluated by shape:

- Numbers and booleans pass through.
- A string containing a sigil reference is an **expression** and is evaluated.
- A string that is exactly `dN` / `NdM` is a **die spec** (see Dice).
- Any other string is plain data and passes through untouched.

```yaml
# Examples (examples/02-expressions.yaml)
sum: $.strength + $.dexterity        # expression → 29
label: Fighter                        # no sigil → stays a string
```

Note: a predicate with no sigil (e.g. `'1 > 2'`) is *not* an expression —
it stays a string. Conditions must reference at least one node to evaluate.

## Expressions

Expressions support arithmetic (`+ - * /`), comparisons, parentheses, nested
calls, and function parameters. Bodies are transpiled to JavaScript, so JS
operator semantics apply. String literals inside expressions are protected
from rewriting.

Every `.name` token is treated as a goblin reference — avoid bare JS property
access (e.g. `foo.bar`) inside expression strings. Comparisons coerce to
`0`/`1` in arithmetic, so thresholds can derive levels without conditionals
(see `5e/character.yaml`).

```yaml
mean: ($.strength + $.dexterity) / 2  # → 14.5
strong: $.strength > $.dexterity      # → true
```

## Dice

`dN` / `NdM` (`d6`, `2d6`, `1d20`) are dice.

- Standalone, a die is a **spec**: it serializes back to its text (`"2d6"`)
  and is *not* rolled.
- Inline in a larger expression, dice are **rolled immediately**.
- A die used in arithmetic rolls (`hit_points + hit_die` rolls the die).

```yaml
# Examples (examples/03-dice.yaml)
hit_die: d8          # → "d8" (spec)
initiative: 1d20 + 2 # → a rolled number between 3 and 22
heal: $.hit_die + 0  # Die in arithmetic rolls → 1..8
```

## Functions

A key of the form `name()` or `name(params)` with a string body defines a
callable. Lookup matches `name` to the `name(params)` entry; calling evaluates
the body per call with the arguments bound. Inside a body, `.` is the record
holding the definition.

The stdlib lives under `$lib`, implicitly loaded by the engine (native
`math`: `floor`, `ceil`, `round`, `abs`, `min`, `max`, merged with
`src/lib.yaml` when present). A document defining its own top-level `lib`
table takes precedence for `$lib.…` refs.

```yaml
# Examples (examples/09-stdlib.yaml)
floored: $lib.math.floor(2.9)      # → 2
smallest: $lib.math.min(3, 9)      # → 3
```

```yaml
# Examples (examples/04-functions.yaml)
utils:
  'ability_modifier(x)': $lib.math.floor((x - 10) / 2)
  'double(x)': x * 2

strength:
  base: 15
  modifier: $.utils.ability_modifier(.base)  # → 2

doubled: $.utils.double(21)  # → 42
'lucky()': 1d20              # zero-arg callable
```

Serialized functions print as `{ :type, :params, :source, :deps }`, with
the body's reference dependencies in order of first appearance — `$lib` refs
are omitted, since the stdlib is implicit. `:source` is whitespace-trimmed
(block scalars leave trailing newlines):

```ts
{
  ':type': 'function',
  ':params': ['x'],
  ':source': '$lib.math.floor((x - 10) / 2)',
  ':deps': [],
}
```

## Templates

`$tmpl('file.yaml')` inlines a deep clone of another loaded document.
References are discovered on load — the engine follows `$tmpl('…')` shapes
recursively (relative to the referring file), so no manual preloading is
needed. Keep `$tmpl('…')` shapes out of comments: the scan is textual.

A tmpl'd document's functions stay callable through the inlined table, with
`.` bound to the template root. Either attach the table under a key…

```yaml
levels: $tmpl('levels.yaml')
level: $.levels.level_for(@.xp.value)
```

…or leave it un-attached and call through the app binding (see Composition),
which keeps the calling document free of the table:

```yaml
level: '#.levels.level_for(@.xp.value)'
```

```yaml
# Examples (examples/05-templates.yaml, examples/05-greeting.yaml)
weapon: $tmpl('05-greeting.yaml')
```

## Metadata

Any `:`-prefixed key (`:doc`, …) is documentation: copied verbatim, never
evaluated — even if its text contains refs.

```yaml
:doc: Tracks health. See $.hit_points.max for the cap (refs here are inert).
```

## Validation

`!validate` lists predicate strings checked by `validate()`, which returns
failure messages (a throwing rule reports `"<rule> → <message>"`). Predicates
evaluate with `.` bound to the containing node; use `.`-relative refs, since
`$`/`@`/`#` inside validation resolve against shared globals, not the actor.

```yaml
# Examples (examples/06-metadata-validation.yaml)
hit_points:
  '!validate':
    - .current >= 0
    - .current <= .max
  current: 7
  max: 12
```

## Applied documents: patches, effects, conditions

A document can be *applied* onto an actor (`engine.apply(actor, file)`),
as class files are. The engine knows nothing of levels: gate per-level
content with `$if` on actor state (e.g. `@.level >= 5`), and derive anything
that is a pure function of level as an unconditional expression. Evaluate
with provided values first so conditions read materialized params. Patch
syntax:

- **Path keys** (`'@.features'`, `'#.hit_points.value'`) target a node by
  absolute ref. In plain evaluation they are skipped, never serialized.
- **`+` additions**: `+name:` sets/adds `name` (merging into objects,
  stripping the prefix). In arrays, `+item` entries append deduplicated;
  other items append raw.
- **`$if` / `$then` conditions** gate a whole node: when `$if` is absent,
  null, or `""` the block is unconditional; otherwise `$if` must evaluate
  truthy. A false condition applies nothing — not even `:meta` — so gated-out
  content leaves no residue. `$then` is itself a patch whose path keys are
  absolute; a bare `$then` without `$if` applies unconditionally.
  `$if`/`$then` are never serialized.
- **Type tags**: a bare `$` key (e.g. `$: Player`) declares the expected actor
  type and is ignored by the engine, as are all bare sigils. `$type: X` (as
  in `wip/player.yaml`) is the legacy spelling: skipped on evaluation, never
  rely on it.

```yaml
# Examples (examples/07-actor.yaml, examples/07-class.yaml)
'@.monk': {}
'@.monk.martial_arts_die': 1d6
'@.features':
  +martial_arts:
    :doc: Your practice of martial arts gives you mastery of combat styles.
  +monks_focus:
    :doc: Spend focus points to fuel monastic techniques.
    $if: '@.level >= 2'
'@.actions.unarmed_strike':
  $if: '@.level >= 2'
  $then:
    '@.actions.unarmed_strike.die': 1d8
    '@.actions.unarmed_strike.type': bonus_action
```

## Statements and assignment

Bodies spanning multiple lines (or `;`-separated) are statement blocks. A
statement of the form `<ref> = <expr>` — where the left side is exactly one
reference — assigns through the sigil (`#.` writes app state, `@.` actor
state, `.` the current node) and clears the resolution cache. The block's
value is its last non-assignment statement (all-assignment blocks evaluate
to `undefined`). Watch the single `=`: `$if: '@.level = 5'` does not compare —
it assigns 5 and passes truthy. Comparisons always use `==`.

```yaml
rest:
  short(): |
    @.hit_points.current = $lib.math.min(@.hit_points.current + @.hit_die, @.hit_points.max)
```

## Composition

A root entry may compose an actor from an `actor` base plus an `adopt` list
of patches (each a `$tmpl('…')` expression or an inline object). A top-level
`actor` key is reserved: any document carrying one is treated as a
composition entry, so never use `actor` as ordinary data. The runner
resolves the base, applies each patch in order, then resolves the merged
result — gate per-level content with `$if` on actor state so choices declared
by adopted patches surface in the `{ query }` envelope. Template paths are
root-relative; nested references resolve relative to their own file.

```yaml
# Examples (5e/main.yaml)
$: Character

# Shared binding: merged into the `#` namespace on load, so every document
# calls #.levels.… without attaching the table itself.
levels: $tmpl('levels.yaml')

actor: $tmpl('character.yaml')
adopt:
  - $tmpl('fighter.yaml')
```

## Parameters

A record containing `:param` declares a value the user must provide. It
evaluates to its declaration metadata plus a `:value` slot holding the
filled value — provided, else `:default`, else `null`:
`{ ':doc'?, ':param', ':type'?, ':default'?, ':value' }`.
`missingParams()` reports every such node as
`[{ path, doc?, type?, options?, count?, unique? }]` — the dotted path
needing a value plus the attached `:doc` and any choice constraints.

- `:param: true` keys the provided value by the node's dotted path.
- `:param: 'alias'` keys it by the alias string instead.
- `:default` supplies the value when nothing is provided — defaulted nodes
  leave the `{ query }` report. Provided values win; defaults type-check
  like provided values. Missing or nullish defaults behave as no default.
- `:type` declares the expected type: `string`, `number`, `integer`,
  `boolean`, `die`, `array`, or `record`. Filling a value of the wrong type
  throws (`param type mismatch: …`); unknown names throw (`unknown param
  type: …`). Untyped params accept anything. The type is included in the
  `missingParams` report.
- `:options` lists the allowed values: a scalar must equal one entry, every
  array item must equal one (`param options mismatch: …`). Anything but an
  array throws (`invalid :options for …`).
- `:count` requires an exact array length (`param count mismatch: …`);
  anything but a non-negative integer throws (`invalid :count for …`).
- `:unique: true` requires distinct array items
  (`param uniqueness mismatch: …`); any other value disables it.
  `:unique` and `:count` ignore non-array values.
- Constraints check provided values and `:default`s alike, apply to `--set`
  overrides, and ride along in the `missingParams` report — e.g. the
  fighter's `skills.trained` declares `:options` (the eight class skills),
  `:count: 2`, `:unique: true` (see `examples/10-choice-params.yaml`).
- `:param` records survive `apply()` (markers copy with other `:meta`), so
  patch files can declare params reported against the merged actor.
- Filled values are readable as `<path>` from other expressions — a bare ref
  to a `:param` node dereferences its filled value (provided, default, or
  `null` when missing), so `@.xp` just works. Descending into a `:param`
  node's `value` slot does not resolve; data records like `hit_points.value`
  are unaffected.
- The CLI `--strip-metadata` flag collapses `:param` records to their
  `:value`, leaving plain values only.

```yaml
# Examples (examples/08-parameters.yaml)
hero_name:
  :doc: The hero's name, as sung by bards.
  :param: true
  :type: string

level:
  :doc: Starting level, 1 through 20.
  :param: starting_level
  :type: integer
```

```ts
engine.missingParams('08-parameters.yaml');
// [
//   { path: 'hero_name', doc: 'The hero's name, as sung by bards.', type: 'string' },
//   { path: 'starting_level', doc: 'Starting level, 1 through 20.', type: 'integer' },
//   { path: 'details.title' },
// ]
engine.evaluateDoc('08-parameters.yaml', { hero_name: 'Aria' });
// hero_name → { ':doc': '…', ':param': true, ':type': 'string', ':value': 'Aria' }
engine.evaluateDoc('08-parameters.yaml', { starting_level: 'high' });
// throws: param type mismatch: starting_level expected integer, got string
```

## Resolution

`resolve(file, provided)` answers a document in one call, returning an
envelope that is either satisfied or asking:

- All `:param` keys present in `provided` → `{ data }` with the serialized
  evaluated document.
- Otherwise → `{ query }` with **only** the outstanding params
  (satisfied ones are filtered out).
- Provided values of the wrong `:type` — or violating `:options` / `:count`
  / `:unique` — still throw instead of resolving.
- `resolve(file, provided, overrides)` writes override values into the tree
  first (`.`/`$`/`@` target the actor, `#` the app; bare paths default to the
  actor). Overridden originals are ignored — derivations never run and
  missing paths are created — but `:param` records keep their `:type`
  contract. CLI flag: `--set path=value` (separate from `--param`).

```ts
engine.resolve('08-parameters.yaml', {}, { hero_name: 'Aria' });
// { data: { hero_name: 'Aria', … } }  (overridden params are not queried)
```

```ts
engine.resolve('08-parameters.yaml', {});
// { query: [
//   { path: 'hero_name', doc: '…', type: 'string' },
//   { path: 'starting_level', doc: '…', type: 'integer' },
//   { path: 'details.title' },
// ] }
engine.resolve('08-parameters.yaml', { hero_name: 'Aria' });
// { query: [ …starting_level…, …details.title… ] }  (hero_name filtered)
engine.resolve('08-parameters.yaml', { hero_name: 'Aria', starting_level: 3, 'details.title': 'Kid' });
// { data: { hero_name: 'Aria', … } }
```

## Evaluation model

- **Lazy and on-demand**: refs resolve when reached; forward references work.
  Resolved values are cached per (document, actor, node, ref).
- Intermediate expression strings (e.g. a `$tmpl('…')` table) evaluate on
  the way down, so refs can descend through them.
- **Circular references** throw (`circular reference: a -> b -> a`).
- **Unresolvable references** throw (`unresolvable reference: …`).
- Loading a file merges its top-level tables into the app namespace
  (first wins), so self-contained docs expose e.g. `#.utils.…`.
- Evaluating a document as its own actor (`evaluateDoc`) makes `$` and `@`
  coincide.

## YAML gotchas

- **Quote `#` expressions**: unquoted, YAML reads `#` as a comment and
  truncates the value — always write `'#.utils.f(…)'`, never `#.utils.f(…)`
  bare. (`@` and `$` need no quoting; `@.x` as a *key* does, for clarity.)
- Sentences with periods (e.g. `end. Start`) look like `.`-refs to the
  expression detector — keep prose in `:doc`, which is never evaluated.
  Numeric literals are safe: no digit follows the `.` in a ref, so `2.5`
  never parses as one.
- `!validate` must be quoted (`'!validate'`) so YAML does not parse `!` as a tag.
