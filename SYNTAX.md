# Goblin Syntax

## Addressibility

Nodes are referenced by path using a leading sigil that determines the root of the lookup.

| Sigil | Root | Description |
|-------|------|-------------|
| `.`   | Current node | Relative path from the node being evaluated |
| `$`   | Document root | Top of the current document (the `.yaml` file) |
| `@`   | Actor root | The actor instance this document is applied to |
| `#`   | App root | Global application namespace (stdlib, shared templates) |

Segments are separated by `.`. A bare sigil with no segments refers to the root itself.

```yaml
# Examples
.base                          # sibling field 'base' on the current node
$.abilities.dexterity          # 'abilities.dexterity' from document root
@.features                     # 'features' on the actor this document is applied to
#.utils.ability_modifier       # 'ability_modifier' in the global utils namespace
```

In a document where the document itself defines the actor (e.g. `player.yaml`), `$` and `@` resolve to the same root. The distinction matters in applied documents (e.g. class files like `monk.yaml`) where `$` is the class document's own namespace and `@` is the character being modified.
