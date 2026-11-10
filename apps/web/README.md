# `apps/web` — Ratel Platform (`@ratel/platform`)

The platform application: the console, the ingest and catalog APIs, the background jobs and the
intelligence that reads them. One Next.js app, two editions
([ADR-0029](../../docs/adr/0029-platform-cloud-modules-private-repository.md),
[ADR-0030](../../docs/adr/0030-platform-oss-layered-core-and-cloud-sync.md)):

- **Ratel OSS** (`RATEL_COMPOSITION=oss`, the default): what this repository builds on its own.
  Needs a Postgres `DATABASE_URL` and nothing else; model keys are optional.
- **Ratel Cloud** (`RATEL_COMPOSITION=cloud`): the same tree plus the private modules checked out at
  `ee/src`. Not built here.

> The application code is arriving from `ratel-cloud` slice by slice through
> [`scripts/platform-sync`](../../scripts/platform-sync/README.md). Until the move completes,
> this folder is a subset of that app; the layout below is the target.

## Layout

```
app/              routes: the console pages (Overview, Agent health, Traces, Catalog, Intents, Quality and its calibration pages, Settings), the first-project flow at /onboarding (outside the shell; where a fresh install lands), the old-address redirects (/dashboard, /traces, /explore, /experiments, /settings and /project/_ to the session organization's project, as upstream's proxy answered them; inside a project, the pages the redesign folded into others), the printable Agent health and Quality reports under (report)/, the /api/* handlers (ingest, catalogs, the MCP server at /api/mcp, the project-key job status at /api/v1/jobs/[id], the retired 410 prefixes), (ee)/ stubs when ee/src is present (gitignored)
components/       React components; the design system lives in packages/design-system
lib/              the core, in layers (see lib/README.md)
parity/           temporary: tests that hold this edition to Ratel Cloud's answers while the platform split audit's items are fixed (see parity/README.md)
Dockerfile        targets `oss` and `cloud`; build context is the repository root
next.config.ts    the #ee-composition alias, /v1 and /v2 rewrites, standalone output
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
pnpm check:boundary && pnpm check:layers   # from the repository root: the structural rules
```

Local development uses Postgres from the root `docker-compose.yml`. From the repository root, with Node 24+, pnpm 10.28+ and Docker:

```sh
pnpm install
docker compose up db                       # Postgres 16 on localhost:5432
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @ratel/platform dev          # http://localhost:3000; migrates on boot, then serves
docker compose up --build                  # or the whole OSS edition in containers, http://localhost:3000
```

One process does everything by default. `APP_ROLE=api` makes it only queue jobs and
`APP_ROLE=worker` makes it run them, which is how `docker-compose.yml` runs `web` and `worker`
([`lib/jobs/README.md`](lib/jobs/README.md)).

`BASE_URL` is where the console's SDK snippets point: this deployment's origin. The console adds
`/api/v1` when it builds API and ingest URLs. It defaults to `http://localhost:3000`; set it in
`.env.local`, or on the container, when the app runs anywhere else.

`dev`, `build` and `typecheck` run `scripts/link-ee.mjs --auto` first, which installs the private
route stubs when `ee/src` exists and removes them otherwise.
