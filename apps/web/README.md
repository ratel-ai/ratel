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
app/              routes: the console pages, the /api/* handlers, (ee)/ stubs when ee/src is present (gitignored)
components/       React components; the design system lives in packages/design-system
lib/              the core, in layers (see lib/README.md)
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
pnpm check:boundary && pnpm check:layers   # from the repository root: the structural rules
```

`dev`, `build` and `typecheck` run `scripts/link-ee.mjs --auto` first, which installs the private
route stubs when `ee/src` exists and removes them otherwise.
