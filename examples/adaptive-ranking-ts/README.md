# `examples/adaptive-ranking-ts` — Ratel adaptive usage ranking

Shows [adaptive usage ranking](../../docs/adr/0013-adaptive-usage-ranking.md) end to end: a `ToolCatalog` learns from the tools an agent actually invokes and reranks similar future queries, then persists what it learned and reloads it in a fresh process. **No model or API key** — it is a pure-Ratel feature demo over BM25.

The scenario is a case description-writing can't fix: BM25 ranks `docker_build` first for *"why is the build broken"* (the token *build*), but the tool people reach for is `gh_run_list`. After a few real invocations the graph closes that gap. See [Capability tools](https://docs.ratel.sh/docs/capability-tools) for the broader wiring; the Python mirror is [`examples/adaptive-ranking-python`](../adaptive-ranking-python/README.md).

## Setup

```bash
pnpm install
pnpm -F @ratel-ai/example-adaptive-ranking start
```

Expected output — the boosted tool climbs after learning and survives the reload:

```
query: "why is the build broken"
  before learning : docker_build > gh_run_list
  after learning  : gh_run_list > docker_build   (rev=4)
  after reload    : gh_run_list > docker_build   (rev=4)

rev 4 -> 5: changed, so persist.
```

(BM25 only returns tools whose text matches the query, so `vault_rotate` — trained on a different query — never appears for a build question; that is retrieval working, not a bug.)

## Layout

```
src/tools.ts         catalog + session — the confidently-wrong catalog, the search->invoke pairs, learn/topIds helpers
src/index.ts         entry — before/after learning, persist via toJson, reload via fromJson, rev-gated save
test/adaptive.test.ts model-free assertion that learning promotes the real tool and survives a reload
```

## How it works, in three calls

- `catalog.enableAdaptiveRanking(graph)` — attach a shared `IntentGraph`; the catalog now learns from every `search` followed by an `invoke`.
- `graph.toJson()` / `IntentGraph.fromJson(...)` — the graph lives in memory, so this is how learning outlives the process. Persist the bytes wherever you keep state. **Sensitive:** they contain the raw text of past user queries (the cluster `members`) — treat a saved graph like your query/telemetry log (restrict permissions, keep it out of version control and images).
- `graph.rev` — a monotonic write counter. Persist only when it changed since your last save (**save-when-changed**), and compare it to a stored graph's `rev` before overwriting to catch a concurrent writer (**stale-base detection**). Single-writer is the supported model.

Semantic and hybrid catalogs work the same way and cluster queries by *meaning* rather than shared words — attach the graph exactly as here; the only cost is the first-run embedding-model download.

## Why it's a separate workspace package

Examples don't ship in `@ratel-ai/sdk` — keeping them out of the published artifact keeps the public API surface narrow and dependency-free. This one pulls only `@ratel-ai/sdk` itself, so it doubles as the smallest possible integration check.
