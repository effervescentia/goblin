# Goblin Syntax

Goblin documents are `.yaml` files evaluated by `src/engine.ts`. Each
`examples/NN-*.yaml` file demonstrates one section of this spec and is kept
runnable by `src/examples.test.ts`.

## Addressability

Nodes are referenced by path using a leading sigil that determines the root of the lookup.

| Sigil | Root | Description |
|-------|------|-------------|
| `.`   | Current node | Relative path from the node being evaluated |
| `#`   | Document root | Top of the current document (the `.yaml` file) |
| `@`   | Actor root | The actor instance this document is applied to |
| `$`   | App root | Global application namespace (shared tables, cross-doc values) |

Segments are separated by `.`. A bare sigil with no segments refers to the root itself.
The dot after a sigil is optional: `#foo.bar` and `#.foo.bar` are equivalent.

```yaml
# Examples (examples/01-addressability.yaml)
.base                          # sibling field 'base' on the current node
#.abilities.dexterity          # 'abilities.dexterity' from document root
@.features                     # 'features' on the actor this document is applied to
$.utils.ability_modifier       # 'ability_modifier' in the global utils namespace
```

In a document where the document itself defines the actor (e.g. `wip/player.yaml`), `#` and `@` resolve to the same root. The distinction matters in applied documents (e.g. class files like `wip/monk.yaml`) where `#` is the class document's own namespace and `@` is the character being modified.

`#` is the document an expression was *written* in. A function body reads
`#` as the document that defines it, wherever it is called from, and the
record a record-bodied call hands back keeps that `#` after it lands in
another tree — so `5e/ability/ability.yaml`'s `entry()` can write
`modifier: '#.modifier(.base)'` and still reach its own `modifier(x)` from
inside the character. (Private `_` ownership is separate: see Private fields.)

No fallback: each sigil names exactly one tree, and a path missing from it
is an unresolvable reference — `@.utils.…` never finds an app-level `utils`;
write `$.utils.…`.

## Wildcards

A `*` path segment matches every child: list items, or record fields —
never metadata, `!validate` rules, functions, patch keys, or another
document's `_` fields. Read, a wildcard ref is the list of its matches that
resolve, in order; a match missing the rest of the path is skipped
(`#.flags.*.on` leaves out a flag with no `on`). Wildcards may repeat
(`@.a.*.b.*`), giving nested lists.

A `{predicate}` segment keeps only the children the predicate holds for,
evaluated with `.` bound to each child; a child missing a field the
predicate reads does not match (`@.resources.{.recover == 'short'}.current`).
It is a wildcard with a filter: `*` is every child, `{…}` the ones that
pass. Inside a record-body function, `{name}` alone is still that
parameter's text (see Functions), so a predicate is never a bare parameter
name.

Assigned (see Statements and assignment), a wildcard ref writes every match,
evaluating the right side once per match with `.` bound to the record being
written — so each match reads its own siblings. Matches whose record does
not exist are skipped.

```yaml
# Examples (examples/13-wildcards.yaml)
maxes: '#.resources.*.max'                          # → [2, 3]
short_maxes: "#.resources.{.recover == 'short'}.max" # → [2]
rest:
  'short()': "#.resources.{.recover == 'short'}.current = .max"
```

5e's rests work this way: every resource declares `recover: short` or
`recover: long`, a short rest refills the `short` ones
(`@.resources.{.recover == 'short'}.current = .max`) and a long rest
refills them all (`@.resources.*.current = .max`), so a class adds a
resource without touching the rest functions.

## Private fields

A key starting with `_` is **private**: only expressions written by the same
document can reference it, through any sigil. Documents compose into one
tree, so "written by" follows provenance rather than where a node sits: a
field belongs to the `:source` of its latest write (see Change events), else
to the document its record came from. A record call (`$.ability.entry(…)`)
hands back nodes owned by the document that made the call.

- A ref from another document that reaches a `_` segment throws
  `private field: <path> belongs to <owner>, not <reader>`.
- Function bodies read as the document that defined them, so a helper can
  use its own document's `_` fields wherever it is called from.
- `!validate` rules run over the evaluated sheet, where `.`-relative refs
  see `_` fields: `5e/ability/standard_array.yaml` keeps its picks as `_assigned`
  and checks them with `$lib.set.subset([…], ._assigned)`.
- Output keeps `_` fields; `--strip-metadata` drops them with the metadata.

```yaml
# Examples (examples/11-private-fields.yaml)
budget:
  _spent: 12
  limit: 27
  left: .limit - ._spent # → 15
```

## Values: plain strings, expressions, dice

A scalar is evaluated by shape:

- Numbers and booleans pass through.
- A string containing a sigil reference is an **expression** and is evaluated.
- A string that is exactly `dN` / `NdM` is a **die spec** (see Dice).
- Any other string is plain data and passes through untouched.

```yaml
# Examples (examples/02-expressions.yaml)
sum: '#.strength + #.dexterity'      # expression → 29
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
mean: '(#.strength + #.dexterity) / 2'  # → 14.5
strong: '#.strength > #.dexterity'      # → true
```

## Indexing

`list[index]` picks one item from a list, counting from 0. A negative index
counts from the end, and an index past either end gives `null`. The index is
any expression, and indexes chain (`#.grid[1][0]`). Indexing anything but a
list, or with a non-integer, throws. A `[` right after a ref, a call or
another index is indexing; anywhere else it opens a list literal
(`$lib.set.subset([1, 2], .picks)`).

5e's roll-and-assign picks a pooled roll with
`'@.roll_assign.rolls[.roll - 1]'` (quoted: YAML reserves a leading `@`).

```yaml
# Examples (examples/12-indexing.yaml)
ranked: [gold, silver, bronze]
first: '#.ranked[0]'              # → gold
last: '#.ranked[-1]'              # → bronze
placed: '#.ranked[#.place - 1]'   # → silver
missing: '#.ranked[5]'            # → null
```

## Dice

`dN` / `NdM` (`d6`, `2d6`, `1d20`) are dice.

- Standalone, a die is a **spec**: it serializes back to its text (`"2d6"`)
  and is *not* rolled.
- Inline in a larger expression, dice are **rolled immediately**. The string
  must contain a sigil ref to be an expression (see above): `1d20 + 2` alone
  is plain text, `1d20 + #.dex_bonus` rolls.
- A die used in arithmetic rolls (`hit_points + hit_die` rolls the die).
- An expression field rolls **once per evaluation**: every ref to it, and the
  evaluated sheet itself, reads the same number (`base: .start` matches a
  rolled `start`). List items count as fields, so a list of rolls holds
  still too. Each new resolve rolls afresh; function calls
  (`'roll()': 1d20 + .base`) roll on every call.

```yaml
# Examples (examples/03-dice.yaml)
hit_die: d8          # → "d8" (spec)
dex_bonus: 2
initiative: '1d20 + #.dex_bonus' # → a rolled number between 3 and 22
heal: '#.hit_die + 0'  # Die in arithmetic rolls → 1..8
```

## Functions

A key of the form `name()` or `name(params)` with a string body defines a
callable. Lookup matches `name` to the `name(params)` entry; calling evaluates
the body per call with the arguments bound. Inside a body, `.` is the record
holding the definition.

A **record body** defines a node instead of an expression: the call hands back
a fresh copy, so two uses never share nodes and a `:param` filled in one does
not show up in the other. Parameters bind into that copy, so one definition covers a family of nodes:
a bare parameter is the argument itself wherever the engine evaluates (a
string with no ref is plain data, and keeps its bare words), and `{param}`
anywhere in a string — metadata included — is its text.

```yaml
# 5e/ability/ability.yaml
'entry(ability, label)':
  start:
    :doc: Starting {label} score, filled in by the chosen ability score method.
  base: .start + $lib.list.count(@.improvements, ability)
'bought(label)':
  bought:
    :label: '{label}'
    :doc: Points bought for {label} above its base 8, 0 to 7 (a score of 8 to 15).
    :param: true
    :type: integer
    :min: 0
    :max: 7
  start: 8 + .bought

# 5e/character.yaml
abilities:
  strength: "$.ability.entry('strength', 'Strength')"

# 5e/ability/point_buy.yaml (a patch: the call merges into the entry above)
'@.abilities':
  $if: "@.ability_method == 'point_buy'"
  strength: "$.ability.bought('Strength')"
```

A call written as a plain document value expands where it stands, so the
`:param` nodes it brings are part of the tree before the query looks for
them. The same holds in patches (`5e/feature.yaml` keeps the ability score
improvement that way, and each granting feature calls it); a call that yields
anything but a record stays as written, and stays lazy.

The stdlib lives under `$lib`, implicitly loaded by the engine, merged with
`src/lib/lib.yaml` when present. A document defining its own top-level `lib`
table takes precedence for `$lib.…` refs. Native namespaces:

- `math`: `floor`, `ceil`, `round`, `abs`, `min`, `max`.
- `dice`: `keep_highest(count, sides, keep)` rolls `count` dice of `sides`
  and sums the `keep` highest — 5e's rolled scores are
  `$lib.dice.keep_highest(4, 6, 3)` (4d6, drop the lowest). It takes numbers,
  since inline `NdM` rolls to a sum before a call could see each die.
- `list`: `count(value, item)`, `has(value, item)` (1 or 0, for arithmetic),
  `size(value)` — reading choices back out of a list, or out of a table of
  `:param` choice records, where a record counts its `:value` and never its
  `:options`. This is how picks become numbers: the 5e fighter's ability
  score improvements are `:count: 2` pick lists, and each ability's score
  counts its own name across them (`10 + $lib.list.count(@.improvements,
  'strength')`), so the same ability twice is +2 and two abilities once each
  is +1 apiece.
- `set`: lists as sets, reading picks the way `list` does. `union(a, b)`,
  `intersection(a, b)` and `difference(a, b)` (in `a`, not in `b`) return
  lists without repeats, in order of first appearance; `subset(a, b)` is 1
  when every item of `a` is in `b`, else 0. Paired with `list.size`, it says
  "each exactly once": 5e's standard array checks
  `$lib.set.subset([15, 14, 13, 12, 10, 8], ._assigned)` and
  `$lib.list.size(._assigned) == 6`.

```yaml
# Examples (examples/09-stdlib.yaml)
floored: $lib.math.floor(2.9)                 # → 2
smallest: $lib.math.min(3, 9)                 # → 3
ability_roll: $lib.dice.keep_highest(4, 6, 3) # → 3..18
athletics_picks: $lib.list.count(@.picks, 'athletics')
```

```yaml
# Examples (examples/04-functions.yaml)
utils:
  'ability_modifier(x)': $lib.math.floor((x - 10) / 2)
  'double(x)': x * 2

strength:
  base: 15
  modifier: '#.utils.ability_modifier(.base)'  # → 2

doubled: '#.utils.double(21)'  # → 42
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
`.` bound to the template root and `#` to the template document. Either
attach the table under a key…

```yaml
levels: $tmpl('level.yaml')
level: '#.levels.level_for(@.xp.value)'
```

…or leave it un-attached and call through the app binding (see Composition),
which keeps the calling document free of the table:

```yaml
level: $.level.level_for(@.xp.value)
```

A patch value that is a single call — `$tmpl('…')` or a call to a
record-bodied function — inlines on the way in, so a repeated node can live
in one place and still be filled: `5e/fighter/fighter.yaml` writes
`'@.improvements.level_4': '$.feature.ability_improvement()'`, and the
`:param` record it hands back lands in the actor tree where the query finds
it.

```yaml
# Examples (examples/05-templates.yaml, examples/05-greeting.yaml)
weapon: $tmpl('05-greeting.yaml')
weight: 100
heft: '#.weapon.heft(2)' # → 8: `heft(n)` reads `#.weight` from 05-greeting.yaml (4)
```

## Metadata

Any `:`-prefixed key (`:label`, `:doc`, …) is documentation: copied verbatim,
never evaluated — even if its text contains refs. `:label` is the node's
display name, for UIs that list nodes by something friendlier than their key;
`:doc` is the longer description.

```yaml
# Examples (examples/06-metadata-validation.yaml)
:label: Hit Points
:doc: 'Tracks health. See #.hit_points.max for the cap (refs here are inert).'
```

Metadata rides along wherever the node goes: it survives `apply()`, shows up
on evaluated `:param` records, and `:label` is reported with the outstanding
params (see Parameters). `--strip-metadata` drops all of it.

## Validation

`!validate` lists predicate strings checked by `validate()`, which returns
failure messages (a throwing rule reports `"<rule> → <message>"`). Predicates
evaluate with `.` bound to the containing node; use `.`-relative refs, since
`$`/`@`/`#` inside validation resolve against shared globals, not the actor.

The CLI runs them on every resolved sheet: failing rules replace the `{ data }`
envelope with `{ errors }`, listing each failure message, so a caller never
receives data that breaks its own rules. `5e/ability/point_buy.yaml` budgets point
buy this way — six `bought` params on the point-buy ladder, a `spent` total,
and `.spent <= ._budget` over them (the budget private to that file) — and
`5e/ability/standard_array.yaml` checks that its six `_assigned` scores use each
array value once: they cover the array
(`$lib.set.subset([15, 14, 13, 12, 10, 8], ._assigned)`) and number six
(`$lib.list.size(._assigned) == 6`).

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

- **Path keys** (`'@.features'`, `'$.hit_points.value'`) target a node by
  absolute ref. In plain evaluation they are skipped, never serialized.
  A `+` in front of the path (`'+@.attacks': 1`) adds to the value already
  there instead of replacing it: two numbers sum, and anything else composes
  an expression, so an added expression stays lazy (`attacks: 1` plus
  `1 + (@.level >= 11)` becomes `(1) + (1 + (@.level >= 11))`). A field
  holding a record or a list has no scalar to add to and is rejected
  (`cannot add to …`). A missing field is simply written.
- **`+` additions**: `+name:` sets/adds `name` (merging into objects,
  stripping the prefix). A plain list replaces the target list — the patch
  states what the list is. A list of `+item` entries adds to it instead,
  appending deduplicated. The two readings are incompatible, so a list that
  mixes them is rejected when the patch applies (`mixed list patch: …`).
- **`$if` / `$then` conditions** gate a whole node: when `$if` is absent,
  null, or `""` the block is unconditional; otherwise `$if` must evaluate
  truthy. A false condition applies nothing — not even `:meta` — so gated-out
  content leaves no residue. Gating on a `:param` turns a choice into
  alternative patches: `5e/character.yaml` mixes in `ability/point_buy.yaml`,
  `ability/standard_array.yaml`, `ability/roll.yaml` and
  `ability/roll_assign.yaml` (see Mixins), each gated on `@.ability_method`,
  so only the chosen method's params reach the next `{ query }`. `$then` is
  itself a patch whose path keys are absolute; a bare `$then` without `$if`
  applies unconditionally. At a document's root, `$if` gates the whole
  applied document (or mixin): false applies none of it.
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

### Change events

Every field a patch writes carries `:events`: the writes that produced it, in
the order they were applied. A record takes `:events` as one more metadata
key, so a feature or `:param` node keeps its own shape; everything else
(scalars, arrays, dice) prints as a `{ :value, :events }` pair. Fields no
patch touched print bare, as before.

- `:source` names the document that made the change — the file name for
  loaded documents and `$tmpl('…')` clones, the name passed to
  `apply(actor, file)` / `applyRaw(actor, patch, source)` otherwise. It is
  omitted when the engine has no name for the tree (e.g. a hand-built actor).
  Values written by `applyOverrides` (the CLI's `--set`) report
  `:source: override`, so an explicit value shows what it beat. Overrides
  apply both before and after the patches, so one that re-writes the value
  already in place is not recorded twice.
- `:line` / `:column` (1-based) point at the key in the `:source` document
  that made the write — the patch key, the field's own declaration for the
  first event, or the function that ran an assignment. They are left out
  when the engine has no text for the document (an override, a hand-built
  tree), so a client can link every other event back to its line.
- `:set` is the value written, resolved: an expression logs its result, not
  its text, evaluated where it landed. The latest `:set` is the field's own
  value, so a roll (`$lib.dice.keep_highest(4, 6, 3)`) logs the number the
  sheet shows; one a later write replaced still resolves (an overridden
  `level` logs what `$.level.level_for(@.xp)` gave). A plain list
  (`- all_armor`) is the document stating the list itself, so it files as
  `:set` holding that list, each item resolved.
- `:add` names what an addition added: the value a `+@.path` key added
  (resolved, like `:set`),
  the items a `+item` list appended, or the key a `+key` record addition
  introduced. A `+key` holding a scalar or a
  list records that value instead, so nothing is logged twice.
- Assignments in statement bodies file events too, under the document whose
  expression made them: `=` as `:set` (the new value), `+=` as `:add` and
  `-=` as `:subtract` (the amount, with any dice rolled once — so the event
  and the field agree). Using Second Wind logs
  `{ ":source": "fighter/fighter.yaml", ":add": 7 }` on `hit_points.current` and
  `{ ":source": "fighter/fighter.yaml", ":subtract": 1 }` on its uses.
- The first event is the value the field already held when the first patch
  or assignment landed, so a history reads base-then-patch. A field a patch
  creates has no such origin event.
- Metadata (`:doc`, `:label`, …) and function definitions are never wrapped.

```ts
// 5e/main.yaml: actor character.yaml, adopt [fighter/fighter.yaml]
"attacks": {                                   // a scalar pairs up
  ":value": 2,
  ":events": [
    { ":source": "character.yaml", ":set": 1 },
    { ":source": "fighter/fighter.yaml", ":add": 1 }     // `1 + (@.level >= 11) + …` at level 5
  ]
},
"second_wind": {                               // a record takes the key in place
  ":label": "Second Wind",
  ":doc": "Regain hit points in a pinch, once per rest.",
  ":events": [{ ":source": "fighter/fighter.yaml", ":add": "second_wind" }]
}
```

References see through the pair — `@.attacks` reads `2`, including from
`!validate` predicates — and `--strip-metadata` collapses it to the value
(dropping in-place `:events` with the other metadata), so stripped output is
unchanged by this.

## Statements and assignment

Bodies spanning multiple lines (or `;`-separated) are statement blocks. A
statement of the form `<ref> = <expr>` — where the left side is exactly one
reference — assigns through the sigil (`$.` writes app state, `@.` actor
state, `.` the current node) and clears the resolution cache. The block's
value is its last non-assignment statement (all-assignment blocks evaluate
to `undefined`). Watch the single `=`: `$if: '@.level = 5'` does not compare —
it assigns 5 and passes truthy. Comparisons always use `==`.

```yaml
rest:
  short(): |
    @.hit_points.current = $lib.math.min(@.hit_points.current + @.hit_die, @.hit_points.max)
    @.resources.{.recover == 'short'}.current = .max
```

`+=` and `-=` add to or take from what the target holds: `x += y` is
`x = x + (y)`, logged as an `:add` / `:subtract` of `y` rather than a `:set`
(see Change events), so 5e's Second Wind heals with
`@.hit_points.current += $lib.math.min(1d10 + @.level, @.hit_points.max - @.hit_points.current) * …`.
On a wildcard target each match adds to its own value.

A wildcard target (`@.resources.*.current`) assigns each match, with the
right side evaluated per match and `.` bound to that match's record (see
Wildcards).

## Composition

A root entry may compose an actor from an `actor` base plus an `adopt` list
of patches (each a `$tmpl('…')` expression or an inline object). A top-level
`actor` key is reserved: any document carrying one is treated as a
composition entry, so never use `actor` as ordinary data. The runner
resolves the base, applies each patch in order, then resolves the merged
result — gate per-level content with `$if` on actor state so choices declared
by adopted patches surface in the `{ query }` envelope. Provided values fill in
before each patch applies, so a later patch can gate on a choice an earlier
one declared: `fighter/fighter.yaml` mixes in its subclasses (see Mixins),
each gated on `@.level >= 3 && @.features.martial_archetype == '…'` (level
first, since `&&` never reads the choice before the fighter declares it). Template paths are
root-relative; nested references resolve relative to their own file.

```yaml
# Examples (5e/main.yaml)
$: Character

# Shared binding: merged into the `$` namespace on load, so every document
# calls $.level.… without attaching the table itself.
level: $tmpl('level.yaml')

actor: $tmpl('character.yaml')
adopt:
  - $tmpl('fighter/fighter.yaml')
```

## Mixins

`$mixin('file.yaml')` merges another document into an actor. The mixin must
declare the actor type it targets with a top-level `$` (`$: Character`);
the engine walks up the template chain — the document holding the call,
then whichever document pulled that one in with `$tmpl` or `adopt` — to the
nearest one declaring the same type, and applies the mixin to the actor that
document builds (an actor document) or patches (an applied one). Provided
choices fill in first, so a mixin can gate on a choice an earlier patch
declared.

- The key holding the call is consumed, and a record left empty by its
  mixin calls goes with it.
- The mixin's writes are patch writes: `:events` cite its file and lines.
- Paths resolve relative to the calling file, like `$tmpl`, and mixins are
  discovered on load the same way (textually — keep the call shape out of
  comments).
- A root `$if` gates the whole mixin, like any applied document
  (`examples/14-mixin-curse.yaml` never applies).
- A mixin without a `$` type throws (`mixin … must declare its actor type…`),
  as does one whose type no document up the chain declares
  (`$mixin('…'): no parent document defines actor type …`).

5e mixes alternatives in this way: the character document mixes in its
ability-score methods (each gated on `@.ability_method`), and the fighter
patch its subclasses (each gated on `@.features.martial_archetype`), so only
the chosen one adds anything. A mixin called from an actor document applies
when the document first evaluates, so place it after the fields it merges
into (`_ability_methods` follows `abilities`):

```yaml
# 5e/fighter/fighter.yaml
$: Character
_subclasses:
  champion: $mixin('champion.yaml')
  battle_master: $mixin('battle_master.yaml')
  eldritch_knight: $mixin('eldritch_knight.yaml')
```

```yaml
# Examples (examples/14-mixin-actor.yaml, examples/14-mixin-boon.yaml)
$: Adventurer
speed: 30
boon: $mixin('14-mixin-boon.yaml') # → gone; '@.speed': 40 lands on this actor
```

## Parameters

A record containing `:param` declares a value the user must provide. It
evaluates to its declaration metadata plus a `:value` slot holding the
filled value — provided, else `:default`, else `null`:
`{ ':label'?, ':doc'?, ':param', ':type'?, ':default'?, ':value' }`.
`missingParams()` reports every such node as
`[{ path, label?, doc?, type?, options?, count?, unique? }]` — the dotted path
needing a value plus the attached `:label` / `:doc` and any choice
constraints, so a UI can prompt with a display name rather than a path.

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
- `:min` / `:max` bound a number inclusively — every item, for an array
  (`param range mismatch: …`); either may stand alone. Non-numeric values
  skip the check (pair with `:type`); a non-number bound throws
  (`invalid :min for …`). 5e point buy declares `:min: 0`, `:max: 7`.
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
  `null` when missing), so `@.xp` just works. `!validate` rules, which read the
  evaluated sheet, see the filled value the same way: 5e's Battle Master
  checks its maneuver picks with
  `$lib.list.size(.*) == $lib.list.size($lib.set.union(.*, []))`. Descending into a `:param`
  node's `value` slot does not resolve; data records like `hit_points.value`
  are unaffected.
- The CLI `--strip-metadata` flag collapses `:param` records (and
  `{ :value, :events }` pairs) to their `:value`, leaving plain values only,
  and drops private `_` fields.

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
- The CLI then validates `{ data }`: any failing `!validate` rule turns it
  into `{ errors }` (see Validation).
- Provided values of the wrong `:type` — or violating `:options` / `:min` /
  `:max` / `:count` / `:unique` — still throw instead of resolving.
- `resolve(file, provided, overrides)` writes override values into the tree
  first (`.`/`#`/`@` target the actor, `$` the app; bare paths default to the
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
  (first wins), so self-contained docs expose e.g. `$.utils.…`.
- Evaluating a document as its own actor (`evaluateDoc`) makes `#` and `@`
  coincide.

## YAML gotchas

- **Quote `#` expressions**: unquoted, YAML reads `#` as a comment and
  truncates the value — always write `'#.utils.f(…)'`, never `#.utils.f(…)`
  bare. A leading `@` needs quoting too (YAML reserves it); `$` needs none.
- **Type tags stay `$`**: a bare `#:` key would be a YAML comment, so the
  type tag is spelled `$: Character` even though `$` is the app root.
- Sentences with periods (e.g. `end. Start`) look like `.`-refs to the
  expression detector — keep prose in `:doc`, which is never evaluated.
  Numeric literals are safe: no digit follows the `.` in a ref, so `2.5`
  never parses as one.
- `!validate` must be quoted (`'!validate'`) so YAML does not parse `!` as a tag.
