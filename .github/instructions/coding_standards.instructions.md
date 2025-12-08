---
applyTo: "**"
---
# Coding Standards

## Principles
KISS, YAGNI, SRP. Simple > Complex. Modular with clear interfaces.

## Size Limits
| Metric | Limit |
|--------|-------|
| File | 300 lines |
| Function | 50 lines |
| Class | 200 lines |

## Code Style
- **Python**: PEP 8, type hints, 100 char limit
- **Node.js**: Prefer `execSync` over `exec` in loops to avoid race conditions and resource exhaustion.

## Cross-Platform & Dev Containers
- **Opening URLs**: Use `"$BROWSER" <url>` instead of `open` (macOS specific) or `xdg-open`.
  - *Context*: VS Code Tasks, Shell Scripts.
  - *Reason*: Ensures compatibility with Dev Containers and Linux environments.
- **Path Verification**: Always verify file paths against actual build artifacts.
  - *Example*: Use `docs/index.html` instead of `index.html` if the build outputs to `docs/`.

## Dependencies (CRITICAL)
**NEVER** run `pip/apt/npm install` directly.

Declare in manifests first:
- Python: root `requirements.txt` (single consolidated file)
- System: `.devcontainer/Dockerfile`
