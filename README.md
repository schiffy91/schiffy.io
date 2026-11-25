# schiffy.io

A photography portfolio built with BTRC. GitHub Pages serves the HTML, CSS, JavaScript, font, and photos from `docs/`. Open `docs/index.html` directly to browse offline.

Run `nix run` to regenerate the checked-in page. `nix build` writes a deployable copy to `result/`. For repeated edits, enter `nix develop` and run `gallery` after changing the template or photo collection.

## Adding photos

Put JPEGs in `docs/img/photography/medium-res/` and run `nix run`. Filenames become photo URLs. The generator reads the dimensions and accounts for EXIF rotation. It keeps the original files intact.

To make smaller gallery images, run `nix run .#previews` before regenerating. BTRC decodes each changed original once, applies its EXIF orientation, and writes a thumbnail within 240 × 240 and a larger preview within 1280 × 960. It preserves embedded RGB color profiles and skips up-to-date files. A photo with no previews uses its original. Include the photos and regenerated page when publishing.

## Gallery controls

The gallery shuffles once per visit. Photos wrap from left to right in justified rows. The arrow keys follow that order and wrap at either end.

Drag left or right, or drag with two fingers on a trackpad, to browse. A zoomed photo pans first, then reveals its neighbor at the edge. Pinch with two or more fingers, pinch on a trackpad, or hold Ctrl or Command while scrolling to zoom. Double-tap or double-click to fit. The minimap shows the visible area and lets you move it.

Pull down past the top edge or pinch smaller than fit to return to the current photo in the grid. On a keyboard, use `+` and `-` to zoom, Shift with an arrow key to pan, `0` to fit, and Escape to close.

Append `?debug` to the URL (or call `lightbox.debug()` in DevTools) to load the modular state-graph debugger (`docs/js/lightbox-debug.js`) and tune gesture parameters live. Run `node --test tests/lightbox.test.mjs` for unit tests and `node tests/lightbox.test.mjs --bench` for hot-path benchmarks.
