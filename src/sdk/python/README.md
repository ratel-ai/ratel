<div align="center">
  <h1>ratel-ai</h1>
  <p>Context engineering for Python agents.</p>

  <p>
    <a href="https://docs.ratel.sh">Docs</a> •
    <a href="https://github.com/ratel-ai/ratel">GitHub</a> •
    <a href="https://discord.gg/75vAPdjYqT">Discord</a>
  </p>

  <p>
    <a href="https://pypi.org/project/ratel-ai/"><img src="https://img.shields.io/pypi/v/ratel-ai?label=pypi&color=3775a9" alt="PyPI" /></a>
    <a href="https://github.com/ratel-ai/ratel/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel?style=social" alt="GitHub stars" /></a>
    <a href="https://github.com/ratel-ai/ratel/blob/main/LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
  </p>
</div>

`ratel-ai` retrieves the tools and skills relevant to each agent turn instead of sending the full catalog to the model. It bundles Ratel's Rust engine in-process: BM25 by default, with configurable semantic and hybrid retrieval available when needed. The default and local-model paths require no API key, vector database, or service. Installing a published package on a supported prebuilt target also requires no Rust toolchain.

Use `ToolCatalog` for ranked tools with sync or async handlers and `SkillCatalog` for ranked Markdown playbooks loaded on demand. Expose `search_capabilities_tool`, `invoke_tool_tool`, and `get_skill_content_tool` so an agent can discover tools and skills, invoke tools, and load full skill instructions. Tools from existing MCP servers can be ingested into the tool catalog with the `mcp` extra. **Experimental — facts:** the opt-in `ratel_ai.experimental` namespace adds `FactCatalog` for constant grounding content (a shop's address, a brand's voice). See [Facts](#facts-experimental) below. This API may change or be removed without a major version bump.

Every tool, skill, and fact accepts an optional experimental `experimental_searchable_description`. It replaces only the description component used by BM25 and embeddings; the model-facing `description` is unchanged, names plus skill/fact tags remain indexed, and opted-in tool schemas are not indexed. When omitted, stable behavior is unchanged: tools rank their description and schema tokens, while skills and facts rank their description. This API may change without a major-version bump.

Semantic and hybrid retrieval use a configurable embedding model ([ADR 0012](../../../docs/adr/0012-configurable-embedding-models.md)), set per catalog via the `embedding` argument: the built-in default, a HuggingFace repo or local directory (in-process), or an OpenAI-compatible endpoint (OpenAI, Ollama, TEI, vLLM).

Hybrid fuses the two arms on normalised scores ([ADR 0024](../../../docs/adr/0024-hybrid-fuses-on-scores.md)). `experimental_dense_weight` (default `0.7`) sets how much of that score the semantic arm carries, with BM25 taking the remainder — `0` is pure lexical, `1` pure dense, and anything outside `[0, 1]` raises rather than being clamped. The default was measured on catalogs of natural-language descriptions; a catalog keyed on exact identifiers, error codes, or internal jargon gives BM25 purchase those corpora do not have and will want a lower value. It is read by `"hybrid"` only and does not scale the adaptive-ranking arm.

Adaptive ranking's `IntentGraph` ([ADR 0014](../../../docs/adr/0014-adaptive-usage-ranking.md)) is host-persisted: core only offers `to_json()`/`from_json()`/`rev`. `LocalFileIntentGraphStorage` and `S3IntentGraphStorage` ([ADR 0025](../../../docs/adr/0025-intent-graph-storage-plugins.md)) are the two ready-made backends — both implement `async load() -> IntentGraph | None` / `async save(graph) -> None`, skip the write when `rev` is unchanged, and raise `StaleIntentGraphError` instead of clobbering a concurrent writer. The S3 backend needs no `boto3` dependency; it signs requests with a built-in SigV4 client:

```python
catalog = ToolCatalog()
storage = S3IntentGraphStorage(bucket="my-bucket", key="intent-graph.json")
graph = await storage.load() or IntentGraph()
catalog.experimental_enable_adaptive_ranking(graph)
# ...later, e.g. on an interval...
await storage.save(graph)
```

For MinIO or another self-hosted S3-compatible service, pass `endpoint`; `force_path_style` defaults to `True` once `endpoint` is set (what MinIO and most self-hosted services require):

```python
S3IntentGraphStorage(
    bucket="my-bucket", key="intent-graph.json", endpoint="http://localhost:9000"
)
```

Both S3 calls are bounded by an idle timeout (`idle_timeout_s`, default 60s): it measures time with **no data moving** rather than total elapsed time, so a slow transfer still completes but a wedged endpoint fails instead of hanging.

**A stored graph carries the raw text of past user queries** (the cluster `members`), so treat it like a query or telemetry log: the file backend writes `0600` and the file belongs outside version control and images, while an S3 bucket holding one wants private access and encryption at rest. Neither backend encrypts the payload; the graph is stored as plain JSON.

For semantic or hybrid retrieval, `register()` folds embedding in: it accepts one tool or a whole batch and embeds on a worker thread, so model loading, HTTP, and inference never block the asyncio loop or hold the GIL — and embedding errors surface right at `register()`:

```python
async def retrieve(tools):
    catalog = ToolCatalog(method="semantic", embedding={"ollama": "nomic-embed-text"})
    await catalog.register(tools)                              # embeds the batch here
    return await catalog.search_async("deploy the service", 5)
```

`register()` is async for every method (BM25 too); `search()` stays synchronous for BM25 only, and `search_async()` covers all three. To change the endpoint's model or vector dimension, construct a new catalog and re-register.

A `SkillCatalog` also takes a whole reloaded catalog at once with `replace_all()`, for a source that fetches the full set rather than individual changes ([ADR 0015](../../../docs/adr/0015-whole-catalog-skill-reload.md)). The batch *is* the catalog: ids missing from it are removed, including ones registered in-process, so a host that mixes local and remote skills composes the batch itself. It mutates in place, so every holder of the catalog sees the reload without being rebuilt.

```python
outcome = await catalog.replace_all([*local_skills, *await fetch_remote_skills()])
print(f"reload: +{outcome.added} -{outcome.removed} ~{outcome.updated}")
```

The corpus swap is the synchronous half of that call, so the counts are already final when it returns — read them without awaiting and a reload whose embedding pass fails still reports what it changed:

```python
reload = catalog.replace_all(batch)  # corpus is live; counts are final
try:
    await reload  # drives the embedding pass
except EmbedderError:
    log.warning("applied +%d -%d, embeddings pending", reload.added, reload.removed)
```

Only new and re-worded skills are embedded — reloading an unchanged catalog costs no embedding calls — and a reload that races an in-flight operation — dense work, but also an ordinary BM25 `search_async` holding the read lock — raises rather than applying half of itself.

Build-time embedding artifacts ([ADR 0018](../../../docs/adr/0018-build-time-embedding-artifacts.md), experimental) avoid corpus/document embedding inference for covered entries on cold start: `experimental_build_embedding_artifact` writes a mixed Tool+Skill RAT1 (halves merged internally; no public merge API), and catalogs accept `experimental_embedding_artifact` (`path` or `bytes`; default `on_miss="error"`) to warm the dense cache on `register` / `replace_all` — each call re-resolves the artifact source and re-warms the whole current corpus. `ToolRegistry` / `SkillRegistry` also expose `experimental_build_embedding_artifact` and `experimental_warm_embeddings_from_artifact`. With default `on_miss="error"`, every id in each non-empty registering corpus must be covered; a tool-only artifact is valid while Skill stays empty (and vice versa); when both sides register, use a mixed artifact or `on_miss="embed"`. Semantic/hybrid search still requires query embedding through the configured backend; Local/HF paths may still initialize/load the model, and endpoint performs its normal remote query embedding. `ArtifactWarmError` covers warm failures (`.code`, `.missing`); `ArtifactError` covers non-embedder artifact construction failures (`EmbedderError` remains the embedding/backend failure); `IncompatibleMergeError` may surface from the high-level mixed builder's internal Tool+Skill composition; writing the output file may raise `OSError`.

## Install

```bash
pip install ratel-ai
# MCP ingestion: pip install 'ratel-ai[mcp]'
```

## Quickstart

Save as `quickstart.py`, then run `python quickstart.py`:

```python
import asyncio
from ratel_ai import ExecutableTool, ToolCatalog

async def main():
    catalog = ToolCatalog()
    await catalog.register(
        ExecutableTool(
            id="get_weather",
            name="get_weather",
            description="Get the current weather for a city.",
            input_schema={"properties": {"city": {"type": "string"}}},
            output_schema={"type": "object"},
            execute=lambda args: {"forecast": f"Sunny in {args['city']}"},
        )
    )

    hit = catalog.search("What is the weather in Rome?", 1)[0]
    print(await catalog.invoke(hit.tool_id, {"city": "Rome"}))


asyncio.run(main())
```

### Mark each request as one turn

Wrap the work for one user request in `catalog.turn(...)`. Every search, skill load, and tool
call inside it, across `await` and the tasks it starts, carries the same `turn_id`, and one
`turn_start` event opens the turn. Concurrent requests keep their own turns.

```python
async def handle(request):
    async with catalog.turn(
        id=request.id,  # optional; a fresh id is minted when omitted
        end_user_id=request.user_id,  # optional; stamped on every event in the turn
        user_message=request.text,  # optional; sent only because you pass it
    ):
        return await run_agent(request.text)
```

A plain `with catalog.turn():` works in sync code. If your framework runs a tool itself instead
of through `catalog.invoke`, record it so the turn still shows the call (`origin: "external"`):

```python
catalog.record_tool_call("web_search", took_ms=120)
catalog.record_tool_call("web_search", error=exc)  # a failed call
```

`ratel_ai.current_turn_id()` returns the active id. See
[ADR 0026](../../../docs/adr/0026-turn-scope.md).

### `turn_id`

An explicit `turn_id` argument still works, and wins over the turn scope.
`search` / `search_async` and `invoke` all take a trailing `turn_id`. Mint **one per user
message** and reuse it for every search and invoke that message produces — including a turn that
searches several times for several subtasks. The `search_capabilities` capability tool's executor
takes `turn_id` as a keyword argument, so a framework adapter passes one per model turn.

It scopes, it does not attribute: within a turn, an invoke is paired with the search that actually
returned that capability, so several searches before any invoke each keep their own evidence
(ADR-0014), whether the graph is learned in-process or by Ratel Cloud replaying your runtime
events. What the id buys is separation — two conversations sharing one catalog must not pair
each other's searches and invokes. Omit it and every caller shares a single scope, which is fine
for one conversation at a time and wrong for concurrent ones.

```python
turn_id = str(uuid.uuid4())
await catalog.search_async("read issues on github", 5, "agent", turn_id=turn_id)
await catalog.search_async("create linear task", 5, "agent", turn_id=turn_id)
await catalog.invoke("read_github_issues", {}, turn_id)  # pairs with the first
await catalog.invoke("create_linear_task", {}, turn_id)  # pairs with the second
```

Continue with the [Python guide](https://docs.ratel.sh/docs/sdks/python), [capability tools](https://docs.ratel.sh/docs/capability-tools), [API reference](https://docs.ratel.sh/docs/api/sdk-python), or the [Pydantic AI example](https://github.com/ratel-ai/ratel/tree/main/examples/pydantic-ai).

## Your own retriever or reranker (experimental)

A catalog can rank with a function you supply, such as a decision model you call ([ADR 0027](../../../docs/adr/0027-custom-retriever-and-reranker-functions.md)). The SDK hands the function the candidates and their searchable text, and knows nothing about the model behind it:

```python
from ratel_ai import RankCandidate, RankedId, ToolCatalog, ratel_jev_plugin

jev = ratel_jev_plugin()                                     # Jev (TypeSafe AI); key in TYPESAFE_API_KEY
ToolCatalog(method="custom", retrieve_fn=jev.retrieve)       # Jev ranks every tool
ToolCatalog(method="bm25", reranker_fn=jev.rerank)           # BM25, then Jev over its top 50
ToolCatalog(method="bm25", reranker_fn=jev.rerank, reranker_depth=20)


async def mine(query: str, candidates: list[RankCandidate], top_k: int) -> list[RankedId]:
    return [{"id": c.id, "score": await my_model(query, c.text)} for c in candidates]
```

- **The contract:** `(query, candidates, top_k)` to a list of `{"id", "score"}`, sync or async. Each `RankCandidate` has `.id`, `.kind` (`"tool"` or `"skill"`) and `.text`. Unknown ids are dropped, each id counts once, and scores are clamped to `[0, 1]`.
  - As `retrieve_fn` (with `method="custom"`) the search returns only the ids the function returned, best first, at most `top_k`.
  - As `reranker_fn` it sees the first stage's top `reranker_depth` (default 50, raised to `top_k`). It can't add a tool the first stage missed; candidates it leaves out follow at 0, in first-stage order.
- **Failures:** whatever `retrieve_fn` raises fails the search. A `reranker_fn` that raises a `RetrieverError` with `transient=True` keeps the first stage's order and records `rerank_fallback:<code>` on the trace; anything else it raises fails the search.
  - A search that fails records no `search` event on the local trace stream, the same as a failed built-in search. The error reaches your `search_async` call and, with telemetry on, marks the `ratel.search` span as an error.
- **Rules:** both need `search_async` (synchronous `search` raises). `reranker_fn` can't be combined with `reranker`, nor with `method="custom"`. `search_async(q, k, reranker=False)` turns either reranker off for one call. `SkillCatalog` takes the same arguments.
- **The Jev plugin:** `ratel_jev_plugin(url=None, api_key_env=None, model=None)` defaults to `https://api.typesafe.ai`, `TYPESAFE_API_KEY` and `jev-latest`, and calls Jev on a worker thread. Above 150 candidates (or 80,000 characters) it judges groups in parallel and fills a final question with their winners. It returns only real picks: probabilities below 0.01 are dropped, except the best one. Its `RetrieverError.code` is `"Config"`, `"Unauthorized"` or `"InvalidRequest"` (not transient), or `"RateLimited"` (with `.retry_after_secs`), `"Overloaded"`, `"Timeout"`, `"Unreachable"`, `"Http"` or `"Malformed"` (transient).
- **Privacy:** **the Jev plugin sends the query and each candidate's searchable text to TypeSafe AI.** The built-in methods never leave the process.

## Reranking (experimental)

A catalog can rank in two stages with built-in methods ([ADR 0027](../../../docs/adr/0027-custom-retriever-and-reranker-functions.md)). `method` picks candidates, and `reranker["method"]` re-scores the top `depth` of them (default 50). A reranker never adds a tool the first stage missed. Either stage can be `"bm25"`, `"semantic"` or `"hybrid"`, but the two stages must use different methods:

```python
catalog = ToolCatalog(method="bm25", reranker={"method": "semantic", "depth": 30})
await catalog.register(tools)    # a semantic reranker makes register() build embeddings
hits = await catalog.search_async("deploy the service", 5)
plain = await catalog.search_async("deploy the service", 5, reranker=False)   # off for one call
```

A reranker needs `search_async`; synchronous `search` raises on a catalog that has one. `SkillCatalog` takes the same `reranker` argument.

## Runtime events and catalog snapshots

`RuntimeEvents` merges tool and skill facts into one bounded push stream. Give the paired
`RuntimeCatalog` the stream's `source_id` so envelopes and full snapshots identify the same
deployment source:

```python
from ratel_ai import RuntimeCatalog, RuntimeEvents, SkillCatalog, ToolCatalog

tools = ToolCatalog()
skills = SkillCatalog()
events = RuntimeEvents(
    [tools, skills],
    session_id="agent-session",
    source_id="checkout-agent",
    experimental_catalog_definitions=True,
)
catalog = RuntimeCatalog(tools, skills, source_id=events.source_id)

async def publish(batch):
    await send_runtime_facts(batch)

subscription = events.subscribe(publish)  # call from the target asyncio event loop
# Register, search, and invoke through tools / skills as usual.
await subscription.flush()
snapshot = catalog.snapshot()
subscription.unsubscribe()
```

Async handlers are marshaled onto the subscribing event loop; synchronous handlers run on the
native callback thread. Both are observational and fail open. `flush()` waits for work already
accepted by the bounded native queues and for async handlers to settle. Subscribing a remote
publisher must set `experimental_catalog_definitions=True` to consent to public
`catalog_definition` fields regardless of the OTel message-content capture setting. Definition events are lossy and change-sensitive; snapshots are
the authoritative full replacement for removals and recovery. They contain sorted public
definitions only—never tool executors or skill bodies. Python exposes no Cloud transport;
applications may publish these events and snapshots through their own adapter.

## Facts (experimental)

Tools and skills are **pulled** — a query ranks them and only the winners reach the model. Facts are the opposite: constant content the agent should always work from (a shop's address, hours, a brand's voice), **pushed** into the context and deduplicated so it is injected once rather than every turn.

Facts live in the opt-in `ratel_ai.experimental` namespace and may change without a major version bump. Registering one is like a skill, plus a `pin` tier:

```python
from ratel_ai.experimental import Fact, FactCatalog, Pin

facts = FactCatalog()
await facts.register([
    Fact(
        id="shop-address",
        name="shop address & hours",
        description="where the shop is and when it's open",
        body="Fade & Blade — 12 Baker Street, London. Open Mon–Sat 9am–7pm.",
        pin=Pin.ALWAYS,       # every turn, regardless of the query
    ),
    Fact(
        id="cancellation",
        name="cancellation policy",
        description="cancelling or rescheduling a booking, and refunds",
        body="Cancel at least 24h ahead for a full refund; same-day is a 50% fee.",
        pin=Pin.RETRIEVED,    # only when the turn's query ranks it in (default)
    ),
])
```

Then pick **one** of two injection modes per turn.

**`ground()` — persist into your stored history.** Returns only the facts not already present; render each `body` verbatim and keep it in the messages you save. It takes a **list of per-message strings** — flatten multi-part content yourself, and note that a bare `str` is rejected (it is itself a `Sequence[str]`, so it would be iterated character by character):

```python
def text_of(message: dict) -> str:
    content = message["content"]
    if isinstance(content, str):
        return content
    return "\n".join(part.get("text", "") for part in content)  # multi-part content

result = await facts.ground(user_text, [text_of(m) for m in messages])
for item in result.inject:
    messages.append({"role": "system", "content": item.body})  # verbatim — presence is the dedupe
```

Turn 1 injects the address; turn 2 sees it in the transcript and injects nothing. It re-injects only when the body is gone (compaction) or was edited — `item.reason` is `"never"` / `"evicted"` / `"mutated"`.

**`ground_snapshot()` — per call, nothing stored.** Returns the full applicable set every time; put it in the request you're about to send and discard it:

```python
snapshot = await facts.ground_snapshot(user_text)
payload = [{"role": "system", "content": f.body} for f in snapshot] + messages
```

Use `ground()` for a long-lived agent whose messages you persist; `ground_snapshot()` for one-shot or stateless calls, or to keep injected content out of your stored history.

Facts are **host-driven**: the model-facing `search_capabilities` tool is unchanged and never returns facts — you decide what is true and inject it, rather than letting the model discover it. Every decision is traced (`fact_inject` with its reason, `fact_inject_skip`, `fact_snapshot`), so the skip rate — the tokens you saved — is measurable. See [ADR-0017](../../../docs/adr/0017-facts-and-injection-freshness.md).

Telemetry export is optional. With the `otlp` extra installed, `configure_telemetry()` reads `RATEL_OTLP_ENDPOINT` (falling back to the superseded `RATEL_URL`, which warns) and `RATEL_API_KEY`, wires trace and Logs exporters, and returns a shutdown handle. It exports only `gen_ai.*`/`ratel.*` signal spans and EventRecords by default — `export_all_spans=True` widens spans only. Message and tool content stays off by default; opt in with `capture_content`/`include_span_and_events` (see the [telemetry guide](https://docs.ratel.sh/docs/telemetry) for the capture modes and their privacy implications). Experimental catalog-definition export additionally requires `RATEL_EXPERIMENTAL_CATALOG_DEFINITIONS=true`. Changed definitions then emit one `ratel.catalog.definition` EventRecord per registry-local content hash. Hosts that already own OpenTelemetry providers add both `ratel_span_processor` and `ratel_log_record_processor` instead.

Package layout: `ratel_ai/` is the Python surface (including `embedding_artifact.py` for build/warm helpers), `native/` contains the PyO3 binding, and `tests/` exercises both. For local development, create `.venv` with `uv`, install `maturin`, `pytest`, `pytest-asyncio`, `ruff`, and `mypy`, then run `.venv/bin/maturin develop` and `.venv/bin/pytest`.
