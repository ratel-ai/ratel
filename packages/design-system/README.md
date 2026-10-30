# @ratel/design-system

Semantic tokens and UI primitives shared by both Ratel editions. Built on
[Base UI](https://base-ui.com) and Tailwind v4; brand palette, fonts and assets come from
[`@ratel/brand`](../brand/README.md).

## Use

In the app's global stylesheet, after Tailwind:

```css
@import "tailwindcss";
@import "@ratel/design-system/styles.css";
```

`styles.css` imports the brand theme, defines the semantic tokens (`bg-app`, `text-fg-muted`,
`border-line`, `bg-accent`, ...), the z-index scale and the focus floor, and registers the
components with `@source`, so Tailwind generates their classes. The app adds the package to
`transpilePackages`.

```tsx
import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
```

Each file in `src/components/` is its own entry point. Components use only the semantic tokens,
never raw colors.

The rules for using them, and for any UI in the platform, are in [`DESIGN.md`](DESIGN.md).

## Layout

| Path | Contents |
|---|---|
| `src/styles.css` | tokens, utilities, focus styles |
| `src/ratel.css` | the brand's palette and type names (`canvas`, `cream`, `forest`, ...) on the semantic tokens, and the global classes `.eyebrow`, `.card-enter`, `.tabular` (also on `.font-mono`) and `.pixel-header`, and the Micro style's animations (`DESIGN.md`, Declared exceptions) |
| `src/cn.ts` | `clsx` plus a `tailwind-merge` that knows the custom scale |
| `src/components/*.tsx` | primitives |
| `src/components/*.ts` | pure logic: keyboard, sorting, tree, peek URL state |
| `test/` | `node:test` suites, run with `pnpm test` |
| `DESIGN.md` | the design language: principles, tokens, components, patterns, copy |
