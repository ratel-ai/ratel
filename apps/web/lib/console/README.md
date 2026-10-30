# `lib/console` (L6)

Console helpers above ingest and the catalog: navigation, shell data, sidebar state, command
search, projects, settings, and development seeds.

| Path | Holds |
|---|---|
| `navigation.ts` | the rail model: project URLs, the destinations this build has plus `composition.nav`, the active item, project switching, the ⌘K entries |
| `scope/command-search.ts` | the ⌘K ranking |
| `project-settings.ts` | renaming a project of the session organization |
| `create-project.ts` | creating a project: the session organization, the plan's cap, a slug unique in the organization |
| `organization-settings.ts` | renaming the session organization and its address, admins only |
| `settings/` | the settings tabs, the API key rows, the SDK events views and payload read, the redirect settle helper, the projects list model and UTC date formats |
| `delete-project.ts` | deleting a project of the session organization once its name is typed back |
| `catalog/` | the Catalog pages' models: the tool and skill rows, the tree, search, paging, the loaders, the runtime-catalog and adoption reads |
| `explore/` | the browser client for the skills API, its form payloads and error copy |
| `shell-data.ts` | the session organization and its projects, once per request, for the shell and the pages |
| `sidebar-cookie.ts` | the persisted collapse state of the sidebar |
| `seed/` | local-database guard, seed organization and project replace, seed command-line args, Site Copilot OTLP/catalog fixtures |

`pnpm --filter @ratel/platform seed` runs `scripts/seed.mts`, which writes Site Copilot through the
traces handler into a local Postgres. On a fresh database it first provisions the operator's
organization, as a first console visit would. Copies and owned files are listed in
`scripts/platform-sync/map.json`.
