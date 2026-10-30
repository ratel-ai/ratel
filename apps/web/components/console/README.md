# `components/console`

The console's own UI, built from `@ratel/design-system` primitives. Product-specific, so it stays
here rather than in the design system.

| Path | Holds |
|---|---|
| `shell/` | the inverted-L frame (DESIGN.md, Layout): `AppFrame` (rail, mobile drawer, ⌘K, `[` and `?`), `Sidebar`, `ProjectSwitcher`, `AccountMenu`, `CommandMenu`, `ShortcutsDialog`, `DatabaseUnavailable` |
| `settings/` | project Settings: General (name), API keys (create, revoke), Developer (SDK events, undelivered events), Danger zone (delete) |
| `org/` | the organization's pages: Projects (list, New project dialog) and Settings > General (name, address) |
| `traces/` | the Traces pages: Runs (volume, stats, run panel), Spans (list or grouped), Logs, and one trace (timeline, conversation, details, ranking); `compare/` holds the trace comparison, unchanged from the Cloud app |
| `errors/` | the 404 (`BrandedNotFound`, the searching badger) and its one link back, and the way back to a project's traces |
| `badgers/` | the honey-badger illustrations from `public/badgers/`, with the badger mark as the fallback when a file is missing |
| `catalog/` | the Catalog pages: the tree of tools and skills, Tools, Skills, the item detail, and the skill editor (rebuilt on the design system) |
| `playground/` | Test a search: a prompt ranked against the live catalog, with what-if edits to descriptions (rebuilt on the design system) |

The navigation model behind the rail is `lib/console/navigation.ts`. Copies and owned files are
listed in `scripts/platform-sync/map.json`.
