# `lib/console` (L6)

Console helpers that sit above ingest and the catalog: scope, navigation, settings, projects,
onboarding, and development seeds.

| Path | Holds |
|---|---|
| `seed/` | local-database guard, replace-project, Site Copilot OTLP/catalog fixtures, demo runtime-catalog tools |

`pnpm --filter @ratel/platform seed` runs `scripts/seed.mts`, which writes Site Copilot through the
traces handler into a local Postgres. Copies and owned files are listed in
`scripts/platform-sync/map.json`.
