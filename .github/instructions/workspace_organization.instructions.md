---
applyTo: "**/Makefile,**/requirements.txt"
description: Workspace structure and file organization standards
---
# Workspace Organization

## Root Files
At root: `Makefile`, `README.md`, `LICENSE`, `.gitignore`, `requirements.txt`
Config dirs: `.github/`, `.devcontainer/`, `.vscode/`

## Single Requirements File
All Python dependencies in root `requirements.txt`:
- Consolidated deps
- No per-directory requirements.txt files

## Directory Structure
```
src/
├── main.py           # Entry point
└── tests/            # Integration tests (pytest)

scripts/              # Setup scripts
resources/test/       # Test media
```

## VS Code Tasks
Tasks defined in `.vscode/tasks.json` use Makefile targets:
- `Build`: `make build`
- `Test`: `make test`
- `Clean`: `make clean`

### Task Separation
- **Pattern**: Decouple build and run/preview tasks.
- **Reason**: "Build" shortcut (Cmd+Shift+B) should strictly build. Opening/previewing should be a separate manual step or a "Test" task to avoid errors in environments where opening is not possible or desired.

## Anti-Patterns
- ❌ Per-directory requirements.txt (use single root file)
- ❌ devenv/nix files (use devcontainer)
- ❌ Build scripts duplicating Makefile targets
- ✅ DO use `/scripts/` for VS Code task commands (port cleanup, service startup)
