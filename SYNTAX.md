# Goblin Syntax

Goblin documents are `.yaml` files evaluated by `src/core/engine.ts`. Each
`examples/NN-*.yaml` file demonstrates one section of this spec and is kept
runnable by `test/examples.test.ts`.

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
counts from the end, and an index past either end gives `null`.
`record[key]` picks the field a string key names, or `null` when it has none.
The index is any expression, and indexes chain (`#.grid[1][0]`). Indexing
anything but a list or a record, a list with a non-integer, or a record with
a non-string throws. A `[` right after a ref, a call or
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
medals: { gold: 3, silver: 1 }
golds: '#.medals[#.ranked[0]]'    # → 3
```

## Labelled expressions

`[Label](expr)` names part of an expression for display. It evaluates to
`expr` unchanged, so it can wrap any operand: a ref, a call, dice, or a
parenthesized sum, nested or not. It is told apart from a list the same way
indexing is: a `[` that does not follow a ref, call or index, whose `]` is
directly followed by `(` (a list is never called). The label is plain text,
never evaluated, and may not be empty or contain unbalanced brackets.

A field whose expression has labels prints as
`{ :value, :formula, :parts }` (a record value takes the two keys in place):

- `:formula` is the expression with each outermost tag read as its label
  (`10 + [Dexterity](@.dex)` → `10 + Dexterity`); unlabelled parts stay
  as written.
- `:parts` lists `{ :label, :value }` for each tag the evaluation reached,
  in the order each finished (an inner tag before the one around it). A tag
  a conditional skipped has no part.

Parts belong to the field whose own expression holds the tags: a labelled
field another one reads, or a labelled function body it calls, keeps its
parts to itself. References see through the wrapper (`@.armor_class` reads
the number), `:events` sit beside the parts when a patch wrote the field,
and `--strip-metadata` collapses it to the value. A `+@.path` addition
composes labelled expressions like any other (`(10) + (Dexterity)`).

```yaml
# Examples (examples/18-labels.yaml)
armor_class: '10 + [Dexterity](#.dexterity)'
# → { ":value": 12, ":formula": "10 + Dexterity",
#     ":parts": [{ ":label": "Dexterity", ":value": 2 }] }
```

## Dice

`dN` / `NdM` (`d6`, `2d6`, `1d20`) are dice.

- Standalone, a die is a **spec**: it serializes back to its text (`"2d6"`)
  and is *not* rolled.
- Inline in a larger expression, dice are **rolled immediately**. The string
  must contain a sigil ref to be an expression (see above): `1d20 + 2` alone
  is plain text, `1d20 + #.dex_bonus` rolls.
- A die used in arithmetic rolls (`hit_points + hit_die` rolls the die).
- An expression field rolls **once per resolve**: every ref to it, and the
  evaluated sheet itself, reads the same number (`base: .start` matches a
  rolled `start`), however often it re-evaluates. List items count as
  fields, so a list of rolls holds still too. Function calls
  (`'roll()': 1d20 + .base`) roll on every call.
- Every roll — an inline `XdY`, a die in arithmetic, a `$lib.dice` call — is
  recorded as one `roll` event with all its faces (see Resolution), and a
  replayed stream hands each one back, so nothing re-rolls under `--in`;
  without one, each new resolve rolls afresh.

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
A second argument names the actor document it pulls in (see Actor
namespaces).
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

…or leave it un-attached and call through the app binding (see Nested actors),
which keeps the calling document free of the table:

```yaml
level: $.level.level_for(@.xp.value)
```

A patch value that is a single call — `$tmpl('…')` or a call to a
record-bodied function — inlines on the way in, so a repeated node can live
in one place and still be filled: `5e/class/fighter/fighter.yaml` writes
`'@.improvements.level_4': '$.feature.ability_improvement()'`, and the
`:param` record it hands back lands in the actor tree where the query finds
it.

Inside a larger expression, `$tmpl(file, name?)` takes computed arguments
and is the call itself, as text (`$tmpl('character.yaml', 'dorn')`): assigned
into the tree, it expands where it lands like one the document spelled out,
namespace and all (see Writing actors in). The file is still a string
literal, so discovery finds it.

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
A rule on a `:param` node itself reads a bare `.` as its filled value.

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
with parameter events first so conditions read materialized params. Patch
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
- **Actor declarations**: a document that defines an actor declares itself
  with `$actor: <name>` (`$actor: Adventurer`); an applied document or mixin
  names the actor it attaches to with a bare `@` key (`'@': Adventurer` —
  quoted, since YAML reserves a leading `@`). Both are skipped on evaluation
  and never serialized; mixins resolve against them (see Mixins). Other bare
  sigils (`$`, `#`, `.`) are ignored as keys. `$type: X` (as in
  `wip/player.yaml`) is a legacy spelling: skipped on evaluation, never rely
  on it.

```yaml
# Examples (examples/07-actor.yaml, examples/07-class.yaml)
'@': Adventurer # 07-actor.yaml declares `$actor: Adventurer`
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
  `:source: override` plus the `:version` (run) of the `override` event that
  wrote them, so an explicit value shows what it beat and when. Overrides
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
  `{ ":source": "class/fighter/fighter.yaml", ":add": 7 }` on `hit_points.current` and
  `{ ":source": "class/fighter/fighter.yaml", ":subtract": 1 }` on its uses.
- The first event is the value the field already held when the first patch
  or assignment landed, so a history reads base-then-patch. A field a patch
  creates has no such origin event.
- Metadata (`:doc`, `:label`, …) and function definitions are never wrapped.
- A labelled field (see Labelled expressions) keeps its `:formula` and
  `:parts` before `:events`.

```ts
// 5e/main.yaml: characters.character_1, a fighter
"attacks": {                                   // a scalar pairs up
  ":value": 2,
  ":events": [
    { ":source": "character.yaml", ":set": 1 },
    { ":source": "class/fighter/fighter.yaml", ":add": 1 }     // `1 + (@.level >= 11) + …` at level 5
  ]
},
"second_wind": {                               // a record takes the key in place
  ":label": "Second Wind",
  ":doc": "Regain hit points in a pinch, once per rest.",
  ":events": [{ ":source": "class/fighter/fighter.yaml", ":add": "second_wind" }]
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

A target can end in indexes (`$.party[name] = …`), each key computed when the
statement runs and naming one path segment: an identifier string, or a
non-negative integer for a list item. Any other key throws (`invalid
assignment key "a.b" for $.party`). Wildcards and indexes do not mix in one
target.

## Nested actors

A document's root is its data: resolving an entry answers the whole tree.
An actor document (`$actor: X`) pulled in anywhere below the root — usually
with `$tmpl('…')` — is an actor of its own: inside it, `#` and `@` are that
record, and its mixins (see Mixins) land on it, not on the document around
it. Each `$tmpl` makes a fresh copy, so one file can fill several slots.

- Its params are asked for by their path from the root
  (`characters.character_1.class`), and `--param` / `--set` address it the
  same way. Inside the actor those values read relative to it, so its own
  expressions and gates (`$if: "@.class == 'fighter'"`) are unchanged.
- Reading into it from outside (`$.characters.character_1.level`, or the
  same through `#`, `@` or `.`) evaluates the target as that actor: its `@`
  and `#` are the nested actor, not the reader's document — functions too,
  so `$.characters.character_1.rest.long()` rests that character. The entry's
  top-level values are shared with `$` once they expand, so `$.x` and `#.x`
  read the same tree.
- Overrides reach it as it expands, before its mixins gate on anything, so
  `--set characters.character_1.level=5` brings in level-5 features.
- Provided values fill in before each mixin applies, so a later one can gate
  on a choice an earlier one declared: `class/fighter/fighter.yaml` mixes in
  its subclasses, each gated on
  `@.level >= 3 && @.features.martial_archetype == '…'` (level first, since
  `&&` never reads the choice before the fighter declares it).
- Template paths are root-relative; nested references resolve relative to
  their own file.

```yaml
# Examples (5e/main.yaml)
# Shared bindings: merged into the `$` namespace on load, so every document
# calls $.level.… without attaching the table itself.
level: $tmpl('level.yaml')

characters:
  character_1: $tmpl('character.yaml') # $actor: Character
```

```yaml
# Examples (examples/15-nested-actors.yaml, examples/15-nested-hero.yaml)
party:
  scout: $tmpl('15-nested-hero.yaml') # query: party.scout.name
  guide: $tmpl('15-nested-hero.yaml') # query: party.guide.name
lead_pace: $.party.scout.pace # the scout's `@.speed` → 40
```

### Actor namespaces

A second `$tmpl` argument names the actor it pulls in:
`$tmpl('character.yaml', 'aria')`. The namespace is an address for
`--param` and `--set`, and nothing more. The actor still lives at its path,
and expressions still read it there (`$.characters.character_1.level`).

- Its params are reported under the namespace (`aria.name`, not
  `characters.character_1.name`). `--param` / `--set` take either key, and
  the namespaced one wins when both are given. Overrides keyed by the
  namespace still land before its mixins gate on anything.
- A namespace is one plain identifier (`[A-Za-z_]\w*`), and only an actor
  document (`$actor: X`) takes one. Anything else throws
  (`invalid actor namespace …`, `only an actor document … takes a
  namespace`).
- Namespaces are checked at runtime, as calls expand: two actors with the
  same namespace anywhere in the tree throw (`duplicate actor namespace aria:
  party.a and party.b`). That includes a template used twice that names an
  actor inside itself. A namespace that matches a top-level key of the entry
  throws too, since `--set aria.x` would be ambiguous.
- A key is routed by its first segment, matched against the namespaces that
  the loaded documents declare.

```yaml
# Examples (examples/16-actor-namespaces.yaml)
party:
  scout: $tmpl('15-nested-hero.yaml') # query: party.scout.name
  guide: $tmpl('15-nested-hero.yaml', 'bree') # query: bree.name
guide_pace: $.party.guide.pace # → 40, or 20 with --set bree.speed=20
```

### Writing actors in

An invoked function can add an actor by assigning a `$tmpl(…)` call to a
computed key: 5e's `recruit(name)` is
`$.party[name] = $tmpl('character.yaml', name)`, so
`--invoke 'recruit("dorn")'` puts a fresh character at `party.dorn` under the
namespace `dorn`.

- The write is the call text, and so is its `:set` and its stream event
  (`{ type: 'set', path: 'party.dorn', value: "$tmpl('character.yaml', 'dorn')" }`),
  not the actor's whole tree. The actor expands after the invoke, mixins
  and all, and overrides given after the invoke land over them.
- Its params are asked for after the invokes run: a run that writes one in
  answers `{ query }` for its choices (`dorn.name`, `dorn.class`, …). The CLI
  saves that state with the invoke's write, and the next run answers it with
  `--in` and `--param` (see Invoking functions).
- Replayed (`--in`), the recorded write makes the actor again and declares
  its namespace, so `--param dorn.…` and `--set dorn.…` reach it.
- The namespace rules hold as for any `$tmpl`: one that shadows a top-level
  key of the entry throws. Writing over a key that already holds an actor
  replaces it.

```yaml
# Examples (examples/17-recruit.yaml)
party:
  scout: $tmpl('15-nested-hero.yaml')
'recruit(name)': $.party[name] = $tmpl('15-nested-hero.yaml', name) # → party.cade as `cade`
```

## Mixins

`$mixin('file.yaml')` merges another document into an actor. The mixin must
name the actor it attaches to with a top-level `@` (`'@': Character`); the
engine walks up the template chain — the document holding the call, then
whichever document pulled that one in with `$tmpl` — to the
nearest one declaring that actor, and applies the mixin to the actor that
document builds (an actor document, `$actor: Character`) or patches (an
applied one, `'@': Character`). Provided
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
- A mixin without a `@` throws (`mixin … must name the actor it attaches
  to…`), as does one whose actor no document up the chain declares
  (`$mixin('…'): no parent document defines actor …`).

5e mixes alternatives in this way: the character document mixes in its
ability-score methods (each gated on `@.ability_method`), and the fighter
patch its subclasses (each gated on `@.features.martial_archetype`), so only
the chosen one adds anything. A mixin called from an actor document applies
when the document first evaluates, so place it after the fields it merges
into (`_ability_methods` follows `abilities`):

```yaml
# 5e/class/fighter/fighter.yaml
'@': Character
_subclasses:
  champion: $mixin('champion.yaml')
  battle_master: $mixin('battle_master.yaml')
  eldritch_knight: $mixin('eldritch_knight.yaml')
```

```yaml
# Examples (examples/14-mixin-actor.yaml, examples/14-mixin-boon.yaml)
$actor: Adventurer
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
- A definition's body (`name(args):` holding a record) is not asked for:
  its params belong to each call's copy, reported where the call lands.
- In a nested actor, params are keyed by their path from the root, or by
  its namespace when it has one (see Nested actors).
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

`evaluateDoc(file, events)` reads only the `parameter` events (see Resolution
for the stream); `override` events take `resolve`.

```ts
engine.missingParams('08-parameters.yaml');
// [
//   { path: 'hero_name', doc: 'The hero's name, as sung by bards.', type: 'string' },
//   { path: 'starting_level', doc: 'Starting level, 1 through 20.', type: 'integer' },
//   { path: 'details.title' },
// ]
engine.evaluateDoc('08-parameters.yaml', [parameter('hero_name', 'Aria')]);
// hero_name → { ':doc': '…', ':param': true, ':type': 'string', ':value': 'Aria' }
engine.evaluateDoc('08-parameters.yaml', [parameter('starting_level', 'high')]);
// throws: param type mismatch: starting_level expected integer, got string
```

## Resolution

Inputs reach the engine as an append-only event stream, the same one the
CLI saves: `InputEvent = { version, type: 'parameter' | 'override' | 'invoke', path, value }`
(`src/inputs.ts`; `parameter(path, value, version = 1)`, `override(…)` and
`invoke(path, args = [], version = 1)` build them; the CLI's `--set` is an
`override`). Replaying the stream, the latest `parameter` / `override` for a
path wins; every `invoke` runs, in order.
`resolve(file, events)` answers a document in one call, returning an
envelope that is either satisfied or asking:

- All `:param` keys filled by a `parameter` event (by path or alias) → `{ data }`
  with the serialized evaluated document.
- Otherwise → `{ query }` with **only** the outstanding params
  (satisfied ones are filtered out). The CLI stamps it like data, as
  `{ hash, version, events, query }` with `hash` over
  `{ version, events, query }`: its events hold the inputs, every roll and
  the writes an invoke made (other writes recompute on replay). `--out`
  saves it and `--in` takes it back, so a choice can be answered in a
  later run; an `{ errors }` result is neither stamped nor saved.
- The CLI then validates `{ data }`: any failing `!validate` rule turns it
  into `{ errors }` (see Validation). A passing result prints as
  `{ hash, version, events, result?, data }` (`result` under `--invoke`; see
  Invoking functions): `version` is `1` for a fresh run and the prior
  state's version + 1 under `--in` (a state without one counts as `0`);
  `events` is the append-only stream of every `--param` / `--set` /
  `--invoke` given so far, in the order given, each tagged with the run that
  gave it, with the engine's writes woven in (see below); and `hash` is
  `sha256:<hex>` of the compact
  `JSON.stringify({ version, events, result, data })` (result and data after
  `--strip-metadata`, when given).
- Every write the engine makes — the same writes field `:events` record —
  joins `events` as `{ version, type: 'set' | 'add' | 'subtract', path,
  value, rolled?, source?, line?, column? }`: `path` runs from the entry
  root (`party.aria.hit_points.current`), `value` is resolved, as printed in
  that field's `:events`, and `rolled: true` marks a value dice produced
  (rolled by the write itself, not read from another rolled field).
  Overrides are left out (their `override` input says it). Writes sit in
  the order made: those made resolving the document ahead of the first
  `invoke` (at the end, with none), and each invoke's after it. A write
  takes its invoke's version, or this run's — unless the replayed stream
  already held it with the same value, which keeps the recorded version.
- Every roll joins `events` too, as one `{ version, type: 'roll', path,
  dice, value }` per roll: `dice` is `XdY` and `value` every face rolled, in
  order — `1d20 + 2` is `{ dice: '1d20', value: [14] }`, and
  `keep_highest(4, 6, 3)` one `4d6` event holding all four faces, the
  dropped one included. They are ordered and versioned like writes. `path`
  is the context it rolled in: the expression field whose evaluation rolled
  it (`initiative`, `strength`), or — for a roll an invoked call made
  itself — the invoke's `path`, under its `version`. Rolls count from the
  first within one evaluation of a field, and within one invoke call; rolls
  outside both (a `$if`, say) share the root context `''`.
- `--in state.json` (or `--in -` for stdin) rehydrates from a prior output
  and replays all of its events. Inputs replay in order (a later parameter
  or override for the same path wins); writes are made again by the inputs,
  each paired with the recorded write in the same place — the nth write of
  its type to its path with the nth recorded one. Every recorded roll
  replays: the nth roll in a context hands back the recorded nth roll's
  faces when its dice match (else it rolls afresh and joins the stream), so rolled
  ability scores, initiative and healing land as they did. Every write an
  invoked function made also keeps its recorded value — a rest replayed
  after a level-up still heals to the max it had then. Other writes
  recompute from the inputs (and replayed rolls), so they follow changed
  inputs. This run's `--param`/`--set`/`--invoke`
  append as events of the incremented `version`. A `hash` that doesn't
  match the rest of the state throws.
- `resolve(file, events)` takes the whole stream: its roll events are the
  tape it rolls from, and its write events hold what invokes wrote.
- Param values of the wrong `:type` — or violating `:options` / `:min` /
  `:max` / `:count` / `:unique` — still throw instead of resolving.
- `override` events write their values into the tree first (`.`/`#`/`@` target
  the actor, `$` the app; bare paths default to the actor). Overridden
  originals are ignored — derivations never run and missing paths are
  created — but `:param` records keep their `:type`
  contract. CLI flag: `--set path=value` (separate from `--param`).

```ts
engine.resolve('08-parameters.yaml', [override('hero_name', 'Aria')]);
// { data: { hero_name: 'Aria', … } }  (overridden params are not queried)
```

```ts
engine.resolve('08-parameters.yaml');
// { query: [
//   { path: 'hero_name', doc: '…', type: 'string' },
//   { path: 'starting_level', doc: '…', type: 'integer' },
//   { path: 'details.title' },
// ] }
engine.resolve('08-parameters.yaml', [parameter('hero_name', 'Aria')]);
// { query: [ …starting_level…, …details.title… ] }  (hero_name filtered)
engine.resolve('08-parameters.yaml', [
  parameter('hero_name', 'Aria'),
  parameter('starting_level', 3),
  parameter('details.title', 'Kid'),
]);
// { data: { hero_name: 'Aria', … } }
```

### Invoking functions

An `invoke` event (CLI: `--invoke fn` or `--invoke 'fn(args)'`, arguments as
JSON values, once per run) calls a function on the fully resolved document.
`value` holds the argument list.

- The path is actor-relative unless led by a sigil, like `--set`, and may
  reach into a nested actor (`party.aria.rest.long`), which the call then
  reads as `@` and `#`.
- Invokes run only once every param is satisfied (a `{ query }` runs none),
  after the overrides and in stream order. Params an invoke brings in (an
  actor it wrote in) are asked for after it runs. Their writes land in `data`, file
  `:events` like any assignment, and follow the invoke in the CLI's
  `events`. An override given after an invoke still wins over what it
  wrote; earlier overrides are the base it works from.
- The CLI only invokes on a stable state. `--invoke` cannot share a run with
  `--param` or `--set` (`--invoke cannot be combined with --param or
  --set…`), and the state it acts on must resolve to `{ data }`: the `--in`
  state, or without one the entry with no inputs (`--invoke needs a stable
  state: …`). An invoke that brings in params answers a `{ query }` state,
  saved like any other, which later runs answer with `--param`.
- The last invoke's return value comes back as `result` (`null` when it
  returns nothing, e.g. an assignment statement; a record-bodied function's
  copy is evaluated). The CLI prints `result` only for this run's
  `--invoke` — between `events` and `data`, inside the `hash` — and `--in`
  replays earlier invokes for their writes without one. Naming anything but
  a function throws (`invoke: x is not a function`).

```ts
engine.resolve('04-functions.yaml', [invoke('utils.double', [21])]);
// { data: { … }, result: 42 }
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
- **Quote the mixin's `@` key**: write `'@': Character`; a bare `@:` is a
  YAML error.
- Sentences with periods (e.g. `end. Start`) look like `.`-refs to the
  expression detector — keep prose in `:doc`, which is never evaluated.
  Numeric literals are safe: no digit follows the `.` in a ref, so `2.5`
  never parses as one.
- `!validate` must be quoted (`'!validate'`) so YAML does not parse `!` as a tag.
- **Quote a leading label**: `'[Base](10) + …'` unquoted is a YAML flow list.
