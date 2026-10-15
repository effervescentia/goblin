# Goblin

## Architecture

**Instances**
App -> Actor -> Document -> Node
**Globals**
App -> Document -> Node

### Effects

Effects are a type of node that can be applied at any point within a document
They are denoted with special prefixes like `+`

### Rules

Distinct from conditions, rules can also be defined anywhere and they will always be required to be true
If rules are declared within conditions they only apply if the condition is true

### Conditions

Gate the application of Effects & Rules by wrapping them in conditions

## Syntax

[`SYNTAX.md`](SYNTAX.md) is the full specification; `examples/` has one
runnable file per feature.

### Special Characters

| Character | Meaning | Spec |
|-----------|---------|------|
| `.` | Current node (also `.`-relative refs in lambdas and rules) | [Addressability](SYNTAX.md#addressability) |
| `#` | Document root | [Addressability](SYNTAX.md#addressability) |
| `@` | Actor root | [Addressability](SYNTAX.md#addressability) |
| `$` | App root (`$lib` is the standard library; bare `$:` is the actor type tag) | [Addressability](SYNTAX.md#addressability) |
| `*` | Wildcard path segment | [Wildcards](SYNTAX.md#wildcards) |
| `_` | Private field, readable only from its own document | [Private fields](SYNTAX.md#private-fields) |
| `:` | Metadata attached to the containing node (`:doc`, `:param`, …) | [Metadata](SYNTAX.md#metadata) |
| `!` | Predicates applied to the containing node (`!validate`) | [Validation](SYNTAX.md#validation) |
| `+` | Addition to a node | [Applied documents](SYNTAX.md#applied-documents-patches-effects-conditions) |

### Reserved Characters

Not yet part of the syntax; held back for future features.

- `?`
- `&`
- `^`
- `~` - intended to indicate a change to a node
