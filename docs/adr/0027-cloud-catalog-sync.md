# 27. Cloud catalog sync

Date: 2026-10-02

## Status

Proposed. Tool sync uses Cloud's existing `PUT /api/v1/catalog/snapshot`; skill and fact sync,
and a catalog version on the picker, need the Cloud changes listed under **Asks of Cloud**.

Required by [ADR-0026](0026-system-one-ranking-and-reranker.md) (Cloud Tool Picker). Builds on
[ADR-0020](0020-runtime-events-lane.md) (`source_id`, the `catalog_definition` content hash) and
[ADR-0022](0022-vendor-neutral-definition-overlay-seam.md) (the pull direction, Cloud → SDK).

## Context

The Tool Picker ranks the project's runtime catalog — `runtime_catalog_entries` rows with
`kind = 'tool'` — and answers `409` when it is empty. Two Cloud channels write that table
(`ratel-cloud`, `lib/db/runtime-catalog.ts`):

- **`PUT /api/v1/catalog/snapshot`** — a full tool snapshot per `source_id`, replaced
  atomically: a tool omitted from a source's snapshot leaves the catalog once no active source
  (seen within `CATALOG_INACTIVE_DAYS`) still lists it. Identical content only heartbeats. It
  answers `{ sourceId, catalogVersion, tools, unchanged }` with `ETag: "<catalogVersion>"`, the
  SHA-256 of the canonical `{ source_id, tools }`. Limits: 20 requests/min per key (burst 40),
  4 MB, 5,000 tools, `source_id` ≤ 512 chars, descriptions ≤ 16,384 chars. **Tools only.**
- **OTLP logs** (`POST /v1/logs`, `ratel.catalog.definition` records) — tools, skills and facts,
  upsert-only with no removals, best effort, and emitted by the SDK only when
  `RATEL_EXPERIMENTAL_CATALOG_DEFINITIONS=true` and content capture are on.

The ADR-0020 runtime-events endpoint (`/api/v1/events`) does not write the catalog.
`@ratel-ai/cloud-sdk`'s `attach()` already publishes snapshots to the first channel; the Ratel
SDK has no publisher of its own, and ADR-0026 puts the picker in the Ratel SDK.

Only the snapshot channel is fit for ranking: complete, restart-safe, with removals. The logs
channel is observation — the same lossiness ADR-0020 states for `catalog_definition` events.

## Decision

**1. One switch.** `cloud` on `ratel()` or on a catalog turns on sync for it. It is explicit
consent to upload the fields below, separate from the OTel content gate and from runtime-events
consent.

**2. Tools sync through the existing snapshot endpoint.** The SDK sends
`PUT {base}/api/v1/catalog/snapshot` (`base` from `cloud.url`, default `https://cloud.ratel.sh`;
bearer from `cloud.apiKeyEnv`, default `RATEL_API_KEY`) with the wire shape Cloud and cloud-sdk
already use:

```json
{ "source_id": "checkout-api",
  "tools": [ { "id": "stripe_refund", "name": "stripe_refund", "description": "…",
               "searchable_description": "…", "input_schema": {}, "output_schema": {} } ] }
```

built from the catalog's existing executor-free `snapshot()`. Executors, validators and
credentials never leave the process. `source_id` is the runtime's existing `sourceId` (ADR-0020),
so two services sharing a project replace only their own tools.

**3. When it runs.** The first sync in a process always sends the full snapshot — that is what
covers restarts. After it, `register`, `replaceAll` and removals trigger a sync, coalesced so a
batch costs one request and the 20/min limit is not a concern for ordinary registration. The SDK
computes the canonical snapshot hash Cloud computes (cloud-sdk's `hashCatalogSnapshot`) and skips
the request when it equals the last acknowledged `catalogVersion`. Limits are checked client-side
first: a catalog over 5,000 tools or 4 MB fails the sync with a clear error rather than a 413.

**4. `register` waits for Cloud.** Sync runs inside the already-async `register` / `replaceAll`,
where embedding runs today, and resolves once Cloud acknowledges it. The SDK keeps the returned
`catalogVersion`; once the picker accepts one (ask 2), pick requests send it so a search right
after `register` never ranks a stale catalog.

**5. Failure keeps the local catalog.** Local registration always succeeds. A failed sync rejects
`register` with the same typed `CloudError` the picker raises (`Unauthorized`, `RateLimited`,
`TooLarge`, `Unavailable`, `Malformed`, …) unless `onSyncError: "warn"` (Python
`on_sync_error="warn"`) is set. The next mutation, or `syncNow()` / `sync_now()`, retries.

**6. Core owns it.** Snapshot building, hashing, coalescing and the HTTP call live in the Rust
`CloudClient` shared with the picker, so TypeScript and Python sync identically.

**7. Skills and facts sync once Cloud accepts them** (ask 1), through the same snapshot, with
`tags` and without bodies or `metadata` unless `syncBodies: true`. Until then they stay local;
the picker is tools-only anyway.

**8. Coexistence with `@ratel-ai/cloud-sdk`.** A host that also calls `attach()` uploads the same
snapshot twice under one `source_id`; Cloud's hash check makes the second a heartbeat. The docs
recommend one or the other.

## Asks of Cloud

1. **Skills and facts in the snapshot** — `skills: [...]`, `facts: [...]` beside `tools`, with
   the same per-source replace semantics, so neither depends on the lossy logs channel.
2. **`catalog_version` on `POST /v1/tools/pick`** — wait for, or reject below, a snapshot version.
3. **A `/v1/catalog/snapshot` rewrite** beside `/v1/tools/pick`, so both live under one base URL
   (today the snapshot is only at `/api/v1/...`).
4. **`kind: skill | fact` on the picker**, when skill and fact picking is wanted.
5. **Source retirement** — an explicit way to drop a `source_id` rather than waiting out
   `CATALOG_INACTIVE_DAYS`.

## Consequences

- The picker ranks a complete, restart-safe catalog, current as of the last `register`, with no
  new Cloud endpoint for tools.
- `register` on a cloud catalog costs a network round trip and can fail; `onSyncError: "warn"`
  trades that for possibly stale picks.
- Tool definitions — names, descriptions, schemas — leave the process for every cloud catalog.
- The Ratel SDK and cloud-sdk both speak the snapshot contract; a change to it lands in both.
- `ratel.catalog.definition` logs keep their role — observation — and are not load-bearing for
  anything Cloud ranks.

## Rejected

- **Syncing through `ratel.catalog.definition` logs or events** — upsert-only, best effort, no
  removals, nothing on an unchanged restart.
- **A new sync endpoint** (this ADR's first draft) — the snapshot endpoint already provides
  per-source replace, hash idempotency and a version.
- **Delegating sync to `@ratel-ai/cloud-sdk`'s `attach()`** — TypeScript-only, and a second
  package for the picker's prerequisite.
