# `lib/console` (L6)

Development seeds.

| Path | Holds |
|---|---|
| `seed/` | local-database guard, seed organization and project replace, seed command-line args, Site Copilot OTLP/catalog fixtures |

`pnpm --filter @ratel/platform seed` runs `scripts/seed.mts`, which writes Site Copilot through the
traces handler into a local Postgres. On a fresh database it first provisions the operator's
organization, as a first console visit would. Copies and owned files are listed in
`scripts/platform-sync/map.json`.
