# 3. Two editions, one application: Cloud modules in a private checkout at `ee/src`

## Status

Accepted

## Context

Ratel OSS and Ratel, the managed edition, run the same application. The managed edition adds identity, organizations,
billing, the admin console, hosted APIs and infrastructure. Two copies of the application
would drift from the first day. The Cloud code must stay private, and an outside contributor
must clone, install, test and open a pull request here with no extra step.

## Decision

**One application, two compositions.** `src` holds the core. Each capability that differs by
edition is a port declared in `src/lib/contracts/`, with an open-source implementation in
`src/lib/adapters/oss/`. `CompositionPorts` (`lib/contracts/composition.ts`) is the full set.
Five ports are required: `session`, `entitlements`, `telemetry`, `embeddingProvider` and
`registry`. The others are optional, and a missing one gives the open-source behaviour: among
them `ui` (the edition's UI slots, `EditionUi`), `featureFlags`, `mcpOAuth`, `apiKeySecrets`
and `connect` (the services the core lends to the edition at startup). The composition root
reads `RATEL_COMPOSITION` (`oss` or `cloud`, default `oss`) and stops the process at startup
when a required port is missing.

**The Cloud modules live in the private repository `ratel-ai/ratel-platform`, checked out at
`ee/src`**, which git ignores here. `ee/package.json` stays public, so the lockfile and
`pnpm install --frozen-lockfile` are the same with or without the checkout.

**Routes, the proxy and static files are copied, not committed.** `scripts/link-ee.mjs` runs
before `dev`, `build` and `typecheck`. With the checkout, it copies the edition's route stubs
to `src/app/(ee)/`, its proxy to `src/proxy.ts` and its public files to `src/public`; without
the checkout, it removes them. Next.js does not follow symlinks for these, so they are copies.

**One boundary rule, checked by `pnpm check:boundary`:** nothing outside `ee/` imports from
`ee/`, except the copied stubs. The private modules import only `@/lib/contracts/*`, their
own code and packages.

**One Dockerfile, two targets** (`oss`, `cloud`). The Cloud adapters are reached through the
build-time alias `#ee-composition`, which resolves to the private composition for Cloud and
to an empty stub otherwise. The `oss` target never copies `ee/`. The `cloud` target fails
without the checkout.

## Consequences

- Contributors never see or need the Cloud code. This repository builds, tests and ships
  Ratel OSS alone, and the OSS image holds no Cloud code (`pnpm check:boundary` guards the imports,
  `pnpm check:dependencies` the packages).
- A Cloud developer works in one tree with one dev server.
- A change to core and Cloud is two pull requests, merged public first. The private CI builds
  against the public branch of the same name. Additive contract changes keep the gap small.
- A new edition capability starts as a change to `CompositionPorts` here.
