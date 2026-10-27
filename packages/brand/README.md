# @ratel/brand

Shared brand for Ratel's websites — one source of truth so `docs.ratel.sh` and
`ratel.sh` stay visually consistent.

## Colors

Import the tokens into any app's global stylesheet:

```css
@import "@ratel/brand/tokens.css";
```

| Token | Value | Use |
| --- | --- | --- |
| `--ratel-indigo` | `#140092` | primary UI accent (links, buttons, active state) |
| `--ratel-indigo-300` | `#9b8cff` | accent on dark surfaces |
| `--ratel-cream` | `#eee3ce` | the badger mark / warm highlights |
| `--ratel-forest` | `#023a2e` | logo tile, deep surfaces |
| `--ratel-green` | `#239452` | success / positive |
| `--ratel-coral` | `#c4431f` | bold marketing surfaces |
| `--ratel-ink` | `#111113` | text on light |

Fonts: **Geist** (sans) and **Geist Mono** — same as ratel.sh.

## Assets

`assets/ratel-mark.png` — the cream honey-badger mark on its forest-green tile
(Ratel's shipped app icon). `assets/ratel-og.png` — social card.

> **Replacing the logo:** these are the official raster marks pulled from ratel.sh.
> If/when a vector (SVG) wordmark + mark is available, drop them in `assets/` and
> point `apps/docs/components/logo.tsx` (and the future `apps/web`) at them.
