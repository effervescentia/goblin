# Goblin

## Architecture

**Instances**
App -> Actor -> Document -> Node
**Globals**
App -> Document -> Node

### Effects

Effects are a type of node that can be applied at any point within a document
They are denoted with special prefixes like `+` or `~`

### Rules

Distinct from conditions, rules can also be defined anywhere and they will always be required to be true
If rules are declared within conditions they only apply if the condition is true

### Conditions

Gate the application of Effects & Rules by wrapping them in conditions

## Syntax

### Special Characters

- `?`
- `:` - indicates metadata attached to the containing node
- `@` - indicates the application
- `.` - indicates the current node, common lambda argument
- `#`
- `!` - indicates a predicate applied to the containing node
- `*`
- `&`
- `^`
- `$` - indicates the current actor
- `+` - indicates an addition to a node
- `~` - indicates a change to a node
