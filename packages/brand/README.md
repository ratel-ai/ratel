# @ratel/brand

Ratel's brand: palette, fonts and logo assets, shared by both editions. UI primitives and
semantic tokens live in [`@ratel/design-system`](../design-system/README.md), which builds on
this package.

## Use

| Export | Contents | For |
|---|---|---|
| `@ratel/brand/theme.css` | Tailwind v4 `@theme`: palette (`--color-*`), data-viz colors (`--color-ctx-*`), font stacks, `@font-face` rules | Tailwind apps; `@ratel/design-system/styles.css` imports it |
| `@ratel/brand/tokens.css` | Raw `--ratel-*` variables on `:root` | Stylesheets without Tailwind |
| `@ratel/brand/assets/*` | Fonts and logos | Copying into an app |

```css
@import "tailwindcss";
@import "@ratel/brand/theme.css";
```

## Fonts

| Family | File | Role |
|---|---|---|
| Geist, Geist Mono | from the `geist` npm package | body and code; the app sets `--font-geist-sans` and `--font-geist-mono` |
| Acid Grotesk (500, 700) | `assets/fonts/acid-grotesk-*.woff2` | display |
| Geist Pixel Square | `assets/fonts/geist-pixel-square.woff2` | pixel accents |

The `@font-face` rules load `assets/fonts/` by relative URL, and the app's bundler emits the
files as static assets. Nothing to copy.

## Assets

| File | Contents |
|---|---|
| `logo-vector.svg` | the badger mark, vector |
| `ratel-badger.png`, `ratel-badger-{128,512,1024}.png` | the badger mark, raster sizes |
| `ratel-mark.png` | the mark on its tile (app icon) |
| `ratel-og.png` | social card |
