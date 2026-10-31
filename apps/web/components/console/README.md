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
| `health/` | Agent health's Summary (`v2/`: the state block, readings, turn shapes, issues with their fix leads and example turns, the self-corrections row, tasks that need a look, call order, unserved asks, the window switch and the report menu), the tool journey it draws, the setup callout and guide, and `report/` (the printable member report). Owned: `v2/SummaryView`, `v2/SummaryMenu`, `v2/HealthStateV2`, `v2/WindowSwitch` (no importer, share link or plan link), `v2/IssuesSection` and `v2/IssueExamples` (the lock on what the limits hide names no plan) and `capture-nudge-model` |
| `tasks/` | Agent health › Tasks: the table, one task (steps, panels, flow diagram, sections), a session turn by turn, the skeletons |
| `self-corrections/` | Agent health › Self-corrections: the hero, where it happens, what the agent said, the change to make, filters and the examples read on demand |
| `fixes/` | Improvements › Fixes: the header and filters, one table per thing you do, a fix's panel, and the kind icons the fix leads and marks share |
| `quality/` | Quality: the header with its window and analysis menu, Misses, Descriptions (rewrites to review, apply or dismiss) and Experiments |
| `adaptive-ranking/` | Adaptive ranking: whether the graph is served, the with-and-without chart, how far it has learned, its setup steps and details |
| `intents/` | the Intents pages: All intents (the table, an intent's panel with its breakdown, steps, sentiment and examples), Flows (the canvas and step panel) and Map (the lens views), the skeletons, the states before a reading and "Read now"; all copies, the adaptive-ranking graph picker left out |
| `intent-map/` | the Map's drawing: intents as blobs, the asks pack, the tool network and globe, their chrome, marks, labels and measurements; all copies |

The navigation model behind the rail is `lib/console/navigation.ts`. Copies and owned files are
listed in `scripts/platform-sync/map.json`.
