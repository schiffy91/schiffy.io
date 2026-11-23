---
applyTo: "flake.nix,generator/**,gallery.html,docs/**"
description: Photography portfolio source and published files
---
# Workspace organization

Keep the generator and its BTRC manifest in `generator/`. Edit the page template in `gallery.html` and regenerate `docs/index.html` with `nix run`. Edit the browser JavaScript and CSS directly in `docs/`.

`flake.nix` defines the build, development shell, and optional preview command.
