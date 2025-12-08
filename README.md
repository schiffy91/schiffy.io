# Photography Portfolio

This is a static site generator for a photography portfolio, hosted on GitHub Pages.

## Build

The project uses `make` for building the site.

### Prerequisites

- Node.js
- Python 3
- ImageMagick (`convert` command)
- `less` (installed via `npm install`)

### Commands

- `make install`: Install Node.js dependencies.
- `make html`: Compile LESS and build HTML from templates.
- `make portfolio`: Resize and optimize images for the portfolio.
- `make all`: Run `clean`, `portfolio`, and `html`.
- `make clean`: Remove generated files.

## Structure

- `build/`: Build scripts (template engine, image resizer).
- `docs/`: Output directory (served by GitHub Pages).
- `docs/img/photography/`: Source images (medium-res) and generated thumbnails/low-res images.
- `docs/js/`: Client-side JavaScript (lazy loading, lightbox).
- `docs/css/`: Styles (LESS).

## Development

To add new photos:
1. Place high-quality images in `docs/img/photography/medium-res`.
2. Run `make portfolio` to generate thumbnails and low-res versions.
3. Run `make html` to update the grid (if necessary, though `grid.js` reads the directory dynamically during build).
