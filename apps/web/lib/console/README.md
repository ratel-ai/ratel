# `lib/console` (L6)

Console helpers above ingest and the catalog: navigation, shell data, sidebar state, command
search, projects, settings, and development seeds.

| Path | Holds |
|---|---|
| `navigation.ts` | the rail model: project URLs, the destinations this build has (inside a project its pages; outside one the organization's Projects, Integrations and Settings) plus `composition.nav`, the active item, project switching, the ⌘K entries |
| `scope/command-search.ts` | the ⌘K ranking |
| `project-settings.ts` | renaming a project of the session organization |
| `create-project.ts` | creating a project: the session organization, the plan's cap, a slug unique in the organization |
| `onboarding/` | the first-project flow at `/onboarding`: `create-first-project.ts` (new here: the project and its Default key in one step, refused in a support session or at the plan's cap), `quickstart.ts` (owned: the send-your-first-trace snippets on a stock OpenTelemetry exporter), `capture-consent.ts` (the "What Ratel will read" copy, a promise about users' data) and `transition.ts` (the exit timings) |
| `organization-settings.ts` | renaming the session organization and its address, admins only |
| `settings/` | the settings tabs, the API key rows, the SDK events views and payload read, the redirect settle helper, the projects list model and UTC date formats |
| `delete-project.ts` | deleting a project of the session organization once its name is typed back |
| `delete-organization.ts` | deleting the session organization and everything it owns once its name is typed back, admins only; refused in a support session or when the entitlements port says a subscription must go first; the next request provisions an empty organization |
| `catalog/` | the Catalog pages' models: the tool and skill rows, the tree, search, paging, the loaders |
| `explore/` | the browser client for the skills API, its form payloads and error copy |
| `shell-data.ts` | the session organization and its projects, once per request, for the shell and the pages |
| `sidebar-cookie.ts` | the persisted collapse state of the sidebar |
| `seed/` | local-database guard, seed organization and project replace, seed command-line args, Site Copilot OTLP, catalog and search fixtures |

`pnpm --filter @ratel/platform seed` runs `scripts/seed.mts`, which writes Site Copilot through the
traces handler into a local Postgres, and stores its capability searches directly. On a fresh database it first provisions the operator's
organization, as a first console visit would. Copies and owned files are listed in
`scripts/platform-sync/map.json`.
