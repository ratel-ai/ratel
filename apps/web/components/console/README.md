# `components/console`

The console's own UI, built from `@ratel/design-system` primitives. Product-specific, so it stays
here rather than in the design system.

| Path | Holds |
|---|---|
| `shell/` | the inverted-L frame (DESIGN.md, Layout): `AppFrame` (rail, mobile drawer, the `[` shortcut), `Sidebar`, `ProjectSwitcher`, `DatabaseUnavailable` |

The navigation model behind the rail is `lib/console/navigation.ts`. Copies and owned files are
listed in `scripts/platform-sync/map.json`.
