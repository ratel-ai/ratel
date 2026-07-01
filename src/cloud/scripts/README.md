# `src/cloud/scripts/`

Runnable checks for the Ratel Cloud telemetry clients — not shipped in any package.

## Layout

```
e2e.mjs        end-to-end check: drives both clients through the full wire path
_py_runner.py  Python side of e2e.mjs (spawned by it; not run directly)
seed.mjs       populate a backend with realistic, category-varied demo events
```

## `e2e.mjs`

Sends the shared [`../fixtures/`](../fixtures/) through **both** clients — the built
`@ratel-ai/cloud` TS package and the `ratel_ai_cloud` Python package — exercising
validate → batch → `POST` with `Authorization: Bearer`. It asserts valid events are
enqueued, invalid ones dropped (never put on the wire), batches split, and the endpoint
accepts them.

The ingest endpoint is **idempotent** — its `{ "accepted": n }` reply counts only
*newly* ingested events, so re-sending the static fixtures reports `accepted: 0`. To
prove genuine ingestion regardless of prior runs, each client also sends one freshly
unique event and asserts `accepted: 1`. Acceptance of the fixture batch is asserted on
the `2xx` response, not on an exact count.

```bash
# offline / CI — spins up a built-in mock ingest server and inspects the wire:
node scripts/e2e.mjs --mock

# against your backend (default http://localhost:3000/api/v1/events):
RATEL_CLOUD_API_KEY=rtl_... node scripts/e2e.mjs

# fail (don't fall back to the mock) if the backend is unreachable:
RATEL_CLOUD_API_KEY=rtl_... node scripts/e2e.mjs --live
```

Config via env: `RATEL_CLOUD_ENDPOINT` (full ingest URL), `RATEL_CLOUD_API_KEY`
(required for a live run). With no flag it hits the endpoint and falls back to the mock
server if nothing is listening. Exit code is `0` only when every assertion passes.

Prerequisites: the TS client built (`pnpm --dir ../ts build`) and the Python dev venv
present (`../python/.venv`; see [`../python/README.md`](../python/README.md)).

## `seed.mjs`

Fills a backend with realistic demo traffic — a mix of agentic / RAG / tool-heavy /
simple / multimodal calls — engineered so the dashboard categorizer attributes tokens
across **all five** context sources (skills, tools, history, memory, user_input), spread
over a time window. A client-side preview mirrors `apps/cloud/lib/categorize.ts`, so it
prints the predicted split and time range before sending.

```bash
# preview only (no send):
RATEL_CLOUD_API_KEY=rtl_... node scripts/seed.mjs --dry

# seed 300 events across the last 30 days:
RATEL_CLOUD_API_KEY=rtl_... node scripts/seed.mjs 300

# custom window:
RATEL_CLOUD_API_KEY=rtl_... node scripts/seed.mjs 120 --days 7
```

Args: `[count]` (default 90), `--days N` (default 30), `--dry`. Endpoint via
`RATEL_CLOUD_ENDPOINT` (default `http://localhost:3000/api/v1/events`). Each event
carries a unique nonce, so re-runs ingest fresh rows rather than deduping.
