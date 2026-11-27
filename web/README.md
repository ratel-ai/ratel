# `src` — Ratel Platform (`@ratel/platform`)

The platform application: the console, the ingest and catalog APIs, the background jobs and the
intelligence that reads them. One Next.js app, two editions
([ADR-0003](../docs/adr/0003-two-editions-one-application.md),
[ADR-0004](../docs/adr/0004-layered-core-and-module-ownership.md)):

- **Ratel OSS** (`RATEL_COMPOSITION=oss`, the default): what this repository builds on its own.
  Needs a Postgres `DATABASE_URL` and nothing else; model keys are optional.
- **Ratel, Cloud edition** (`RATEL_COMPOSITION=cloud`): the same tree plus the private modules checked out at
  `ee/src`. Not built here.

## Layout

```
src/              the app's code (Next.js src folder)
  app/            routes: the console pages (Overview, Agent health, Traces, Catalog, Intents, Quality and its calibration pages, Settings), the first-project flow at /onboarding (outside the shell; where a fresh install lands), the old-address redirects (/dashboard, /traces, /explore, /experiments, /settings and /project/_ to the session organization's project, as upstream's proxy answered them; inside a project, the pages the redesign folded into others), the printable Agent health and Quality reports under (report)/, the public pages of an Agent health share link under share/ (the read-only page at /share/health/<token> under its share bar, and its printable /report: a 404 unless the edition supplies share links), the /api/* handlers (ingest, catalogs, the MCP server at /api/mcp, the project-key job status at /api/v1/jobs/[id], the retired 410 prefixes), (ee)/ stubs when ee/src is present (gitignored)
  components/     React components; the design system lives in packages/design-system
  lib/            the core, in layers (see src/lib/README.md)
  config.ts       every setting and feature flag, read once (zfig): env, a JSON file, or both
  config-defaults.ts  every setting's default; also the browser's config (`@/config` in browser bundles)
  instrumentation.ts, proxy.ts (Cloud, copied from ee/src)  Next.js hooks; they sit beside app/
public/           static files
scripts/          dev, seed, migration and build scripts
Dockerfile        targets `oss` and `cloud`; build context is the repository root
next.config.ts    the #ee-composition alias, the browser's `@/config`, /v1 and /v2 rewrites, standalone output
config.example.json  a sample config file (see Configuration)
```

## Commands

```sh
pnpm --filter @ratel/platform dev          # http://localhost:3000, OSS edition
pnpm --filter @ratel/platform build
pnpm --filter @ratel/platform typecheck
pnpm --filter @ratel/platform lint         # biome
pnpm --filter @ratel/platform test         # node:test; integration tests run on an embedded Postgres (pglite)
pnpm --filter @ratel/platform seed         # Site Copilot OTLP + catalog into the local database
pnpm --filter @ratel/platform seed:quality # Quality: its searches, answer key, runs and rewrites (needs the seed above)
pnpm --filter @ratel/platform load-test:ingest -- --mode queued  # ADR-0009's load test, local database only
pnpm check:boundary && pnpm check:layers   # from the repository root: the structural rules
```

Local development uses Postgres from the root `docker-compose.yml`. From the repository root, with Node 24+, pnpm 10.28+ and Docker:

```sh
pnpm install
docker compose up db                       # Postgres 16 on localhost:5432
cp web/.env.example web/.env.local
pnpm --filter @ratel/platform dev          # http://localhost:3000; migrates on boot, then serves
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build  # or the whole OSS edition in containers, http://localhost:3000
```

## Configuration

Every setting and feature flag is read through one module, [`src/config.ts`](src/config.ts): the
schema, each setting's environment variable and its parsing rule. A setting comes from the
environment, from a JSON config file, or from both:

- **Environment**: the variables in [`.env.example`](.env.example) (`.env.local` in development, the
  container's environment in a deployment).
- **File**: `CONFIG_PATH=/path/to/config.json`. Its shape is the schema's nested keys, for example
  `{ "database": { "url": "postgres://…" }, "flags": { "evalGate": true } }`;
  [`config.example.json`](config.example.json) shows a few.
- **Both**: each setting is taken from the first source that sets it: **env > file > default**. A
  blank env value counts as unset.

An invalid value stops the process at boot with a `ConfigError` that names the key and its
environment variable; so does a `CONFIG_PATH` that names no file. Code reads `getConfig()`; tests and
scripts build one with `resolveConfig({ env, configPath })`. Only `NODE_ENV`, the `NEXT_*` variables
Next reads, `next.config.ts`'s build-time variables and the variables a third-party SDK reads itself
stay outside it (listed at the top of `config.ts`).

Feature flags have semantic keys (`evalGate`, `rankingCatalogDrift`, `mcpApps`, `agentsPages`,
`toolRunInsights`, `focusedConsole`, `customMonitoring`, `evals`): in the file `flags.<key>`, in
the environment `FF_EVAL_GATE`, `FF_RANKING_CATALOG_DRIFT`, `FF_MCP_APPS`, `FF_AGENTS_PAGES`,
`FF_TOOL_RUN_INSIGHTS`, `FF_FOCUSED_CONSOLE`, `FF_CUSTOM_MONITORING` (it also turns on RQL) and
`FF_EVALS`. `evals` gates Ratel sandboxes and the evals on them together. A flag
takes `true`, `1`, `false` or `0`; unset, it is not forced (the edition decides, else off).

One process does everything by default. `APP_ROLE=api` makes it only queue jobs and
`APP_ROLE=worker` makes it run them, which is how `docker-compose.yml` runs `web` and `worker`
([`lib/jobs/README.md`](src/lib/jobs/README.md)). With the experimental ingest queue
(`EXPERIMENTAL_INGEST_QUEUE=1`, [ADR-0009](../docs/adr/0009-queued-ingest.md)) two more roles
exist: `ingest` only queues ingest batches and never migrates, `persist` only persists them.

`BASE_URL` is where the console's SDK snippets point: this deployment's origin. The console adds
`/api/v1` when it builds API and ingest URLs. Every snippet passes that address to the Cloud SDK
explicitly rather than leaning on the SDK's hosted default
([`snippet-endpoints.test.ts`](src/lib/console/onboarding/snippet-endpoints.test.ts) checks). It defaults to `http://localhost:3000`; set it in
`.env.local`, or on the container, when the app runs anywhere else.

`RATEL_EXPERIMENTAL_FEATURES=1` (`experimentalFeatures`) turns on the experimental features left in the open-source
edition: the eval gate, adaptive ranking's catalog drift (the gone-tool warning only for tools a
published catalog dropped, closable warnings, gone tools pruned on rebuild), MCP Apps, the MCP
server's interactive `ui://` views ([`lib/mcp/apps`](src/lib/mcp/apps/README.md)), Scorers, custom Dashboards, Alerts, and tool-run
insights (tasks from small projects, a derived ask for a tool-only run, an OTel `invoke_agent` root
as an agent run with its own turn and task, and an Agent health reading from 10 turns marked low
confidence). Cloud ignores it and reads each flag (`evalGate`, `rankingCatalogDrift`, `mcpApps`,
`toolRunInsights`) on its own. The eval gate's pages live in the
route group `app/(console)/(eval-gate)`, whose layout answers a real 404 with the feature off, above
the project's loading boundary. Everything else is on for everyone, as upstream retired its flags:
session replay (with What-if and the session chat), the redesigned trace views, raw OTLP capture,
Traces Sessions, adaptive labelling, the Health score and the quick and import first readings. The
session pages keep their route group `(session-replay)`, and `(stage-spine)` (Tasks and Ship) is on
for everyone.

`dev`, `build` and `typecheck` run `scripts/link-ee.mjs --auto` first, which installs the private
route stubs when `ee/src` exists and removes them otherwise. It also copies the edition's static
files (`ee/src/src/public/`) into `public/`, git-ignored and listed in `.ee-public.json`, never
replacing a file the app ships. They, and `test`, then build the MCP Apps views (`pnpm
mcp-apps:build`, which runs the [`@ratel/mcp-apps`](../mcp-apps/README.md) package's build into its
git-ignored `mcp-apps/dist/`). The app reads that output only, through the package's `VIEWS_PATH`
(`src/lib/mcp/apps/load.ts`); `pnpm mcp-apps:dev` serves the views with their fixtures at
`http://localhost:4180`.

## API keys and scopes

Every project API key carries scopes (ratel-cloud #428, `lib/platform/api-keys/scopes.ts`), one
per bearer surface, and every route checks its own. A key without the scope a route needs gets
`403` with a plain reason (`{"error":"forbidden","reason":"missing_scope","scope":"catalog:read",…}`),
never `401`. Settings › API keys offers Full access (stored as `*`; every key issued before scopes
existed is Full, migration `0037_api_key_scopes`), Read-only, Ingest only and Custom. An ingest-only
key starts with `rtl_pub_`: it can add telemetry to its own project and nothing else, so it is the one
key safe to ship inside an app. Because one such key is shared by every install, its ingest gets
shared-key limits on top (`lib/ingest/ingest-limits.ts`: per key, per caller address, and per span
or record; `RATEL_PUBLISHABLE_KEY_LIMIT_PER_MINUTE`, `RATEL_PUBLISHABLE_SOURCE_LIMIT_PER_MINUTE`,
`RATEL_PUBLISHABLE_KEY_ITEMS_PER_MINUTE`, `RATEL_PUBLISHABLE_SOURCE_ITEMS_PER_MINUTE`, or a key's own
`rate_limit_per_minute`), and is append-only: it never replaces a stored row, opens a facts era,
rewrites the runtime catalog or restates a stored model call. `apiKeyPolicy` (`policy.ts`) is the one
place that reads a key's scopes, and `routes.test.ts` fails a bearer route that does not declare and
pass its scope (`BEARER_ROUTE_SCOPES`). `POST /api/internal/keys/resolve` is the one other key lookup: it
takes `RATEL_INTERNAL_SECRET` instead of a key and answers 404 while that is unset
([`docs/internal-api.md`](../docs/internal-api.md)). The quickstart snippets embed the newest Full key.
