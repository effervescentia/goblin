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
| `#`   | App root | Global application namespace (stdlib, shared templates) |

Segments are separated by `.`. A bare sigil with no segments refers to the root itself.
The dot after a sigil is optional: `$math.min` and `$.math.min` are equivalent.

```yaml
# Examples (examples/01-addressability.yaml)
.base                          # sibling field 'base' on the current node
$.abilities.dexterity          # 'abilities.dexterity' from document root
@.features                     # 'features' on the actor this document is applied to
#.utils.ability_modifier       # 'ability_modifier' in the global utils namespace
```

In a document where the document itself defines the actor (e.g. `player.yaml`), `$` and `@` resolve to the same root. The distinction matters in applied documents (e.g. class files like `monk.yaml`) where `$` is the class document's own namespace and `@` is the character being modified.

Cross-namespace fallback: when a path is missing under `$` or `@`, the app
root is tried next (so `@.utils.…` works when the app supplies `utils`); a
missing `#` path falls back to the current document. `$.math.*` / `#.math.*`
always resolve to the stdlib (see Functions).

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
access (e.g. `foo.bar`) inside expression strings.

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

The stdlib `math` (`floor`, `ceil`, `round`, `abs`, `min`, `max`) is available
as `$.math.*` / `#.math.*` (or dot-less: `$math.min(…)`).

```yaml
# Examples (examples/04-functions.yaml)
utils:
  'ability_modifier(x)': $.math.floor((x - 10) / 2)
  'double(x)': x * 2

strength:
  base: 15
  modifier: $.utils.ability_modifier(.base)  # → 2

doubled: $.utils.double(21)  # → 42
'lucky()': 1d20              # zero-arg callable
```

## Templates

`$.tmpl('file.yaml')` inlines a deep clone of another loaded document. The
referenced file must already be loaded — the CLI preloads `$.tmpl('…')`
references recursively before evaluating.

```yaml
# Examples (examples/05-templates.yaml, examples/05-greeting.yaml)
weapon: $.tmpl('05-greeting.yaml')
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
    - .value >= 0
    - .value <= .max
  value: 7
  max: 12
```

## Applied documents: patches, effects, conditions, levels

A document can be *applied* onto an actor (`engine.apply(actor, file, level)`),
as class files are. Patch syntax:

- **Path keys** (`'@.features'`, `'#.hit_points.value'`) target a node by
  absolute ref. In plain evaluation they are skipped, never serialized.
- **`+` additions**: `+name:` sets/adds `name` (merging into objects,
  stripping the prefix). In arrays, `+item` entries append deduplicated;
  other items append raw.
- **`$if` / `$then` conditions** gate a node: when `$if` is absent, null, or
  `""` the block is unconditional; otherwise `$if` must evaluate truthy.
  `$then` is itself a patch whose path keys are absolute. Non-control sibling
  keys still apply; `$if`/`$then` are never serialized.
- **Numeric keys** (`1:`, `2:`, …) are level blocks: every level `≤ maxLevel`
  applies in document order.
- **Type tags**: a bare `$` key (e.g. `$: Player`) declares the expected actor
  type and is ignored by the engine, as are all bare sigils.

```yaml
# Examples (examples/07-actor.yaml, examples/07-class.yaml)
'@.boon': {}

1:
  '@.boon.die': 1d8
  '@.features':
    +unarmored_defense:
      :doc: Base AC becomes 10 + Dex + Wis while unarmored.
      $if: # empty (comment-only) $if counts as unconditional
      $then:
        '@.armor_class': 10 + @.abilities.dexterity.modifier + @.abilities.wisdom.modifier

2:
  '@.features':
    +monks_focus: {}
  '@.actions.unarmed_strike':
    +die: '@.boon.die'
```

## Statements and assignment

Bodies spanning multiple lines (or `;`-separated) are statement blocks. A
statement of the form `<ref> = <expr>` — where the left side is exactly one
reference — assigns through the sigil (`#.` writes app state, `@.` actor
state, `.` the current node) and clears the resolution cache. The block's
value is its last non-assignment statement.

```yaml
rest:
  short(): |
    #.hit_points.value = $.math.min(#.hit_points.value + #.hit_die, #.hit_points.max)
```

## Parameters

A record containing `:param` declares a value the user must provide. It
evaluates to `{ ':doc'?, ':param', value }`, where `value` comes from the
provided values (or `null` when missing). `missingParams()` reports every
such node as `[{ path, doc?, type? }]` — the dotted path needing a
value plus the attached `:doc`.

- `:param: true` keys the provided value by the node's dotted path.
- `:param: 'alias'` keys it by the alias string instead.
- `:type` declares the expected type: `string`, `number`, `integer`,
  `boolean`, `die`, `array`, or `record`. Filling a value of the wrong type
  throws (`param type mismatch: …`); unknown names throw (`unknown param
  type: …`). Untyped params accept anything. The type is included in the
  `missingParams` report.
- `:param` records survive `apply()` (markers copy with other `:meta`), so
  patch files can declare params reported against the merged actor.

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
// hero_name → { ':doc': '…', ':param': true, ':type': 'string', value: 'Aria' }
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
- Provided values of the wrong `:type` still throw instead of resolving.

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
// { data: { hero_name: { …, value: 'Aria' }, … } }
```

## Evaluation model

- **Lazy and on-demand**: refs resolve when reached; forward references work.
  Resolved values are cached per (document, actor, node, ref).
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
- `!validate` must be quoted (`'!validate'`) so YAML does not parse `!` as a tag.
