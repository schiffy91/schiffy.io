---
applyTo: "**/*.agent.md,**/*.instructions.md,**/*.prompt.md"
description: Architectural patterns and modular design standards
---
# Architectural Patterns

## Modular Design
- **Separation of Concerns**: Keep business logic separate from UI/API.
- **Single Responsibility**: Each module should have one clear purpose.
- **Interface Segregation**: Define clear interfaces between modules.

## Refactoring Checklist
After renaming/moving, verify: `grep -r "old_pattern" .`
Check: markdown links, imports, configs, instructions

## Anti-Patterns
- ❌ Relative paths in configs
- ❌ Duplicating instruction files (use redirects/symlinks)
- ❌ Creating directories for single files

## Supersession Pattern
When one milestone/feature replaces another:
1. Mark old milestone as "⚠️ Superseded by X" in milestones.md
2. Use strikethrough for deleted items: ~~old item~~
3. Keep history visible (don't delete, archive)
4. Run Janitor to find stale references
