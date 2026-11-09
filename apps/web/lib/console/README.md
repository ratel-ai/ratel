# `lib/console` (L6)

Console helpers above ingest and the catalog: navigation, shell data, sidebar state, command
search, projects, settings, and development seeds.

| Path | Holds |
|---|---|
| `navigation.ts` | the rail model: project URLs, the destinations this build has (inside a project its pages; outside one the organization's Projects, Integrations and Settings) plus `composition.nav`, the same rail grouped into Monitor, Insights, Improve and Ship (with the Ship page, and Tasks as a top-level page under Insights in place of Agent health › Tasks) when `stageSpine` is passed (`FF_STAGE_SPINE`), the active item, project switching, the ⌘K entries, where `/dashboard` lands |
| `scope/command-search.ts` | the ⌘K ranking |
| `scope/project-scope.ts` | one project of the session organization, or a 404 |
| `scope/legacy-redirects.ts`, `scope/moved-pages.ts` | upstream's old-address rules: `/traces`, `/explore`, `/experiments`, `/settings` to their project pages, and the pages the redesign folded into others |
| `scope/legacy-route.ts` | new here: those two rules chained for a console route, since this edition has no proxy to answer them (ADR-0029) |
| `scope/sentinel.ts`, `scope/landing.ts`, `scope/cookie.ts` | `/project/_/…`, the last project a reader was in (owned: the cookie only, checked against the session organization; upstream also keeps a pointer on the user) and the cookie that remembers it |
| `project-settings.ts` | renaming a project of the session organization |
| `create-project.ts` | creating a project: the session organization, the plan's cap, a slug unique in the organization |
| `onboarding/` | the first-project flow at `/onboarding`: `create-first-project.ts` (new here: the project and its Default key in one step, refused in a support session or at the plan's cap), `quickstart.ts` (owned: the send-your-first-trace snippets on a stock OpenTelemetry exporter), `capture-consent.ts` (the "What Ratel will read" copy, a promise about users' data) and `transition.ts` (the exit timings); the sample project: `provision-sample.ts` (owned port of upstream's demo provisioning: an organization with no projects and no `sample_project_seeds` row gets Site Copilot once, inline from `shell-data.ts`, the mark claimed before the seed so a failed or deleted sample never returns), with its `schema.ts` and `queries.ts` |
| `settings/` | the settings tabs, the API key rows, the SDK events views and payload read, the redirect settle helper, the projects list model and UTC date formats |
| `delete-project.ts` | deleting a project of the session organization once its name is typed back, refused in a support session |
| `catalog/` | the Catalog pages' models: the tool and skill rows, the tree, search, paging, the loaders |
| `explore/` | the browser client for the skills API, its form payloads and error copy |
| `shell-data.ts` | the session organization and its projects, once per request, for the shell and the pages |
| `sidebar-cookie.ts` | the persisted collapse state of the sidebar |
| `seed/` | local-database guard, seed organization and project replace, seed command-line args, Site Copilot OTLP and catalog fixtures, and `site-copilot-seed.ts`: the seed itself (the project, its key and catalog, the traces through the route handler, the queued ledger build), shared by the seed script and the sample provisioner; `settle-queue.ts`: after each of the seed's drain ticks, waits for a job a worker is running and drains what is left queued, so the result does not depend on a worker; `task-loop.ts`: the task loop demo, run through the production jobs (live scores, eval sets, a draft, two simulations, a shipment and its post-ship measure), with its PGlite test |

`pnpm --filter @ratel/platform seed` runs `scripts/seed.mts`, which writes Site Copilot through the
traces handler into a local Postgres and drains the jobs it queued. On a fresh database it first provisions the operator's
organization, as a first console visit would. `pnpm --filter @ratel/platform seed:task-loop --project
<id or slug> [--no-models]` runs `scripts/seed-task-loop.mts` on a project the seed built (with
`--drain`): the task loop demo; `--no-models` uses the local stand-ins and calls nothing out.
Copies and owned files are listed in
`scripts/platform-sync/map.json`.
