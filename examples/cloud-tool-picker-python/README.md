# `examples/cloud-tool-picker-python` — the Ratel Cloud Tool Picker

This is the Python mirror of [`examples/cloud-tool-picker-ts`](../cloud-tool-picker-ts/README.md); see that README for the full walkthrough. A `ToolCatalog(cloud=...)` uploads its catalog to Ratel Cloud on `register` and ranks through the [Tool Picker](https://docs.ratel.sh/cloud/tool-picker) in `search_async` ([ADR-0026](../../docs/adr/0026-system-one-ranking-and-reranker.md), [ADR-0027](../../docs/adr/0027-cloud-catalog-sync.md)).

**No API key needed.** `local_cloud.py` is a local stand-in for the two Cloud endpoints, and it speaks the real wire contracts. Its ranking is a toy, so it shows the plumbing, not ranking quality.

## Run

```bash
uv run main.py
```

Expected output (the port and version vary):

```
ratel cloud: http://127.0.0.1:55857  (local stand-in)

query: "the customer was charged twice, give them their money back"

local bm25        : stripe_list_charges (1.74) > stripe_create_charge (1.71) > stripe_create_customer (0.27)
synced            : 7 tools, version fa4857373074
  re-sync         : skipped=True (nothing changed)

cloud precise     : stripe_refund_payment (0.90) > stripe_list_charges (0.01) > crm_log_note (0.00)
cloud instant     : stripe_list_charges (0.20) > stripe_refund_payment (0.20) > crm_log_note (0.10)
cloud exhaustive  : stripe_refund_payment (0.90) > stripe_list_charges (0.01) > crm_log_note (0.00)

cloud down:
  register        : warned (RuntimeWarning)
  search          : CloudError code=Unavailable
```

To use Ratel Cloud, set `RATEL_CLOUD_URL=https://cloud.ratel.sh` and `RATEL_API_KEY`. This syncs the example's tools into your project under the source id `cloud-tool-picker-example`. **A `cloud` catalog sends its tool names, descriptions and schemas, and every query, to Ratel Cloud.**

## Layout

```
tools.py        the payments catalog, the query, a hit printer
local_cloud.py  local stand-in for PUT /api/v1/catalog/snapshot and POST /v1/tools/pick
main.py         entry — local bm25, sync on register, the three modes, failure behaviour
```

## The Python spelling

- `ToolCatalog(cloud={"mode": "precise", "url": ..., "api_key_env": ..., "source_id": ..., "on_sync_error": "warn"})`.
- `await catalog.sync_now()` re-syncs. `await catalog.search_async(q, k, mode="instant")` overrides the mode for one call.
- Failures:
  - A failed sync or pick raises `CloudError` (a `RuntimeError`) with `.code`, `.status` and `.retry_after_secs`.
  - `on_sync_error="warn"` turns a failed sync into a `RuntimeWarning`.
