# `examples/cloud-tool-picker-ts` — the Ratel Cloud Tool Picker

This example shows [ADR-0027](../../docs/adr/0027-system-one-ranking-and-reranker.md) and [ADR-0028](../../docs/adr/0028-cloud-catalog-sync.md) end to end. A support agent's tool catalog is owned by Ratel Cloud: `register` uploads it, and `searchAsync` ranks through the [Tool Picker](https://docs.ratel.sh/cloud/tool-picker). Local BM25 picks the wrong tool for a refund request. The picker's judged modes pick the right one.

**No API key needed.** `src/local-cloud.ts` is a local stand-in for the two Cloud endpoints, and it speaks the real wire contracts. Its ranking is a toy (word overlap, plus a hard-coded intent table in place of the system-one judge), so it shows the plumbing, not ranking quality. The Python mirror is [`examples/cloud-tool-picker-python`](../cloud-tool-picker-python/README.md).

## Run

```bash
pnpm install
pnpm -F @ratel-ai/example-cloud-tool-picker start
```

Expected output (the port and version vary):

```
ratel cloud: http://127.0.0.1:55841  (local stand-in)

query: "the customer was charged twice, give them their money back"

local bm25        : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)
synced            : 7 tools, version fa4857373074
  re-sync         : skipped=true (nothing changed)

cloud precise     : stripe_refund_payment (0.90) > stripe_list_charges (0.01) > crm_log_note (0.00)
cloud instant     : stripe_list_charges (0.20) > stripe_refund_payment (0.20) > crm_log_note (0.10)
cloud exhaustive  : stripe_refund_payment (0.90) > stripe_list_charges (0.01) > crm_log_note (0.00)

cloud down:
ratel: cloud catalog sync failed; picks may rank a stale catalog until the next register or syncNow(): ratel cloud unavailable: io: Connection refused
  search          : CloudError code=Unavailable
```

## Against Ratel Cloud

```bash
RATEL_CLOUD_URL=https://cloud.ratel.sh RATEL_API_KEY=... \
  pnpm -F @ratel-ai/example-cloud-tool-picker start
```

- **What changes in your Cloud project:** it syncs the example's 7 tools under the source id `cloud-tool-picker-example`.
- **Credits:** `precise` and `exhaustive` are metered against your Tool Picker credit, while `instant` is free.
- **Privacy:** **a `cloud` catalog sends its tool names, descriptions and schemas, and every query, to Ratel Cloud.**

## Layout

```
src/tools.ts        the payments catalog, the query, a hit printer
src/local-cloud.ts  local stand-in for PUT /api/v1/catalog/snapshot and POST /v1/tools/pick
src/index.ts        entry — local bm25, sync on register, the three modes, failure behaviour
```

## The options it uses

- `ratel({ cloud: { mode, url?, apiKeyEnv?, sourceId?, onSyncError? } })`, or the same `cloud` on a standalone `ToolCatalog`.
  - `mode` is `"instant"`, `"precise"` (the default) or `"exhaustive"`.
  - `sourceId` names this service's catalog in the project.
- `register` resolves once Cloud has acknowledged the catalog. `syncNow()` re-syncs, and it skips the request when nothing changed.
- `searchAsync(q, k, { mode })` overrides the mode for one call. Synchronous `search` throws on a `cloud` catalog.
- Failures:
  - A failed sync rejects `register` with `CloudError`, or only warns with `onSyncError: "warn"`. Either way the tools stay registered locally.
  - A failed pick throws `CloudError` with a stable `.code`.
