# `@ratel-ai/cloud`

Pull-sync loader for a networked catalog source, speaking the frozen
[protocol/v1](../../../protocol/v1/README.md) contract: conditional `GET /v1/catalog` with the
frozen ETag algorithm, Bearer auth, and an opaque `?scope=` selector. `createSkillSync()`
attaches a source to a [`@ratel-ai/sdk`](../ts/README.md) `SkillCatalog` and returns a running
handle; retrieval (the capability tools) stays entirely local over the hydrated replica
([ADR-0003](../../../docs/adr/0003-catalog-source-interface.md)).

## Usage

```ts
import { SkillCatalog } from "@ratel-ai/sdk";
import { createSkillSync } from "@ratel-ai/cloud";

const catalog = new SkillCatalog();

// Resolves RATEL_URL / RATEL_API_KEY from the environment (explicit options win).
const sync = createSkillSync(catalog); // immediate first refresh + periodic chain
// ... sync.lastSyncedAt / sync.consecutiveFailures surface staleness; sync.stop() detaches.
```

`syncSkills(catalog, options?)` is the one-shot variant — it throws on any failure, while
`createSkillSync` tolerates an unreachable source (the replica runs degraded and staleness is
surfaced on the handle).

Synced skills are **owned by the loader**: a host-registered skill with a colliding id is never
touched and is reported in `SyncResult.conflicts`. A full resync of identical data emits zero
catalog churn.

## Layout

```
src/
  canonical.ts        frozen v1 content projection, ETag, scope-overlay resolver
  errors.ts           typed error taxonomy over the frozen error body
  fetch-catalog.ts    one conditional GET of /v1/catalog
  skill-sync.ts       SkillSync: refresh diffing (ownership rule) + timer chain
  index.ts            createSkillSync / syncSkills entry points
  testing/            in-process mock source (`@ratel-ai/cloud/testing`)
```

## Package shape

- Package name: `@ratel-ai/cloud`
- Pure TypeScript (no native binding); depends on `@ratel-ai/sdk`
- MIT ([ADR-0009](../../../docs/adr/0009-licensing.md)); member of the pnpm workspace
- The canonicalizer, the mock source, and the loader are pinned against
  [`protocol/v1/conformance/vectors.json`](../../../protocol/v1/conformance/vectors.json)

## Build & test

From the repo root:

```bash
pnpm --filter @ratel-ai/cloud build
pnpm --filter @ratel-ai/cloud typecheck
pnpm --filter @ratel-ai/cloud lint
pnpm --filter @ratel-ai/cloud test
```
