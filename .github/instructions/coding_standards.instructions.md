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

## Build and dependencies

Use the pinned Nix flake for the development shell and site build. The BTRC generator uses the standard library. Keep the published gallery self-contained, with browser-native HTML, CSS, and JavaScript.

GitHub Pages serves `docs/`. Check changes to the generator against the page produced by `nix run`.
