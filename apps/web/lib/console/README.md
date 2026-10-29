# `lib/console` (L6)

Development seeds.

| Path | Holds |
|---|---|
| `navigation.ts` | the rail model: project URLs, the destinations this build has plus `composition.nav`, the active item, project switching, the ⌘K entries |
| `scope/command-search.ts` | the ⌘K ranking |
| `calls.ts` | the Model calls page: a project's `events`, newest first, keyset-paged |
| `project-settings.ts` | renaming a project of the session organization |
| `format.ts` | timestamps that render the same on the server and in the browser |
| `shell-data.ts` | the session organization and its projects, once per request, for the shell and the pages |
| `sidebar-cookie.ts` | the persisted collapse state of the sidebar |
| `seed/` | local-database guard, seed organization and project replace, seed command-line args, Site Copilot OTLP/catalog fixtures |

`pnpm --filter @ratel/platform seed` runs `scripts/seed.mts`, which writes Site Copilot through the
traces handler into a local Postgres. On a fresh database it first provisions the operator's
organization, as a first console visit would. Copies and owned files are listed in
`scripts/platform-sync/map.json`.
