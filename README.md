# schiffy.io

A photography portfolio built with BTRC. GitHub Pages serves the HTML, CSS, JavaScript, font, and photos from `docs/`. Open `docs/index.html` directly to browse offline.

Run `nix run` to regenerate the checked-in page. `nix build` writes a deployable copy to `result/`. For repeated edits, enter `nix develop` and run `gallery` after changing the template or photo collection.

## Adding photos

Put JPEGs in `docs/img/photography/medium-res/` and run `nix run`. Filenames become photo URLs. The generator reads the dimensions and accounts for EXIF rotation. It keeps the original files intact.

To make smaller gallery images, run `nix run .#previews` before regenerating. BTRC decodes each changed original once, applies its EXIF orientation, and writes a thumbnail within 240 × 240 and a larger preview within 1280 × 960. It preserves embedded RGB color profiles and skips up-to-date files. A photo with no previews uses its original. Include the photos and regenerated page when publishing.

## Gallery controls

The gallery shuffles once per visit. Photos wrap from left to right in justified rows. The arrow buttons and arrow keys follow that order and wrap at either end.

Scroll over the open photo to zoom at the pointer. Drag the photo to pan, or use the minimap to jump to a spot and drag the outlined area. The zoom buttons also work on touchscreens. On a keyboard, use `+` and `-` to zoom, Shift with an arrow key to pan, `0` to fit, and Escape to close.
