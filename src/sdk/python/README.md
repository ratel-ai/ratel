<div align="center">
  <h1>ratel-ai</h1>
  <h4>Context engineering & usage analytics for any Python agent — one dependency.</h4>

  <p>
    <a href="../../../docs/">Docs</a> •
    <a href="../../../docs/roadmap.md">Roadmap</a> •
    <a href="https://discord.gg/hdKpx69NR">Discord</a>
  </p>

  <p>
    <a href="https://pypi.org/project/ratel-ai/"><img src="https://img.shields.io/pypi/v/ratel-ai?label=pypi&color=3775a9" alt="PyPI" /></a>
    <a href="https://github.com/ratel-ai/ratel/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel?style=social" alt="GitHub stars" /></a>
    <a href="https://discord.gg/hdKpx69NR"><img src="https://img.shields.io/discord/1478702964003705015?logo=discord&logoColor=white&color=7289da&label=discord" alt="Discord" /></a>
    <a href="../../../LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
  </p>
</div>

`ratel-ai` ([Ratel](../../../README.md)'s Python SDK) does two things for an agent, each one dependency away, in-process, with no service to deploy:

- **Engineers its context** — ranks your tools (and skills) so only the handful relevant to *this* turn enter the prompt, instead of a wall of 100 definitions the model has to wade through. Fewer input tokens, sharper tool choice. Ranking is BM25 over a schema-aware projection of each tool: deterministic, no embeddings, no vector DB, no inference cost.
- **Measures it** — ships one *usage rollup* per agent interaction to your dashboard: token spend per context source, plus what Ratel selection saved. Best-effort, batched, never throws; no API key → no-op.

Adopt either, at the depth you want — **[Get started](#get-started)** shows the two levels, smallest first. It bundles the Rust core (`ratel-ai-core`) via [PyO3](https://pyo3.rs); the binding strategy is locked in [ADR 0011](../../../docs/adr/0011-python-rust-binding-strategy.md).

## Install

```bash
pip install ratel-ai
# upstream MCP ingestion (register_mcp_server) needs the extra:
pip install 'ratel-ai[mcp]'
# observability + analytics (ship traces to Ratel's cloud) needs the extra:
pip install 'ratel-ai[observability]'
```

Prebuilt `abi3` wheels ship for darwin-arm64, darwin-x64, linux-x64-gnu, linux-arm64-gnu, and win32-x64-msvc, so there is nothing to compile. The base SDK runs on CPython ≥ 3.9; the `mcp` extra requires ≥ 3.10.

## Get started

Ratel meets your agent at two levels, and they **compose** — engineer the context, then measure it.

### 1 · Engineer the context — register a catalog

Passing a big tool list to the model on every turn? Register a `ToolCatalog` and Ratel ranks it: pre-filter the top-K most relevant tools each turn, hand the agent a `search_capabilities` + `invoke_tool` gateway for the rest, add skills and MCP servers — the full catalog never enters the prompt.

```python
from ratel_ai import ToolCatalog, ExecutableTool

catalog = ToolCatalog()
catalog.register(ExecutableTool(
    id="read_file",
    name="read_file",
    description="Read a file from local disk and return its contents.",
    input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
    execute=lambda args: {"contents": open(args["path"]).read()},
))
# ...register your other tools, then pre-filter the top-K each turn or hand the agent
# search_capabilities + invoke_tool. See "How it works" below.
```

More → [How it works](#how-it-works) · [`ToolCatalog`](#toolcatalog).

### 2 · Measure it — ship a usage rollup

Once you know what each turn costs, ship one *usage rollup* per interaction to your dashboard: token spend per context source, plus what Ratel selection saved. Best-effort, batched, never throws.

```python
from ratel_ai import get_client

get_client().track(
    tokens_by_category={"skills": 120, "tools": 2000, "history": 3400,
                        "memory": 260, "user_input": 340},
    saved_by_category={"tools": 7200},   # optional: what selection kept out of the prompt
    model="claude-sonnet-4-6", output_tokens=180,
)
```

`pip install 'ratel-ai[observability]'`, then set `RATEL_API_KEY` to ship to your dashboard (no key → silent no-op, never raises). More → [Usage analytics](#usage-analytics).

### Which level do I want?

| You want… | Use | Code change |
|---|---|---|
| Lower token cost: gateway, skills, MCP, dispatch | **1** — `ToolCatalog` | register tools |
| Usage analytics on your dashboard | **2** — `get_client().track(...)` | one call per interaction |

They stack: register a catalog (1) to shrink the prompt, then `track()` (2) the result so the dashboard shows the saving. The rest of this README is the reference for each.

## How it works

*This section is **Level 1** — the full `ToolCatalog`. For the usage-analytics path, see [Usage analytics](#usage-analytics).*

Everything starts with a **`ToolCatalog`**: register each of your tools once, pairing its metadata (id, description, JSON schemas) with the handler that runs it. From there you reach the model in one of two ways, and most agents use both at once:

- **Pre-filter (top-K).** Before each model call, ask the catalog for the few tools most relevant to the user's message and put *those* in the tool list. The full catalog never enters the prompt. This is Ratel's replace-by-default tool injection ([ADR 0003](../../../docs/adr/0003-tool-selection-replace-vs-suggest.md)).
- **Dynamic gateway.** Give the agent two always-present tools, `search_capabilities` (find more tools by description) and `invoke_tool` (run one by id), so it can reach the rest of the catalog on its own when the pre-filtered set is not enough.

The two compose: the pre-filter covers the common case in the prompt, and the gateway is the escape hatch for everything else. Tools can be local functions, an upstream MCP server's tools (via [`register_mcp_server`](#register_mcp_server-ingest-an-mcp-server)), or both. The model sees one unified, ranked surface.

## Quickstart

Register a catalog, then build each turn's tool list from the gateway plus the top-K hits for the user's message.

```python
from ratel_ai import (
    ToolCatalog,
    ExecutableTool,
    search_capabilities_tool,
    invoke_tool_tool,
)

catalog = ToolCatalog()
catalog.register(
    ExecutableTool(
        id="read_file",
        name="read_file",
        description="Read a file from local disk and return its textual contents.",
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string", "description": "absolute path to the file"}},
            "required": ["path"],
        },
        output_schema={"type": "object", "properties": {"contents": {"type": "string"}}},
        execute=lambda args: {"contents": open(args["path"]).read()},
    )
)
# ...register the rest of your tools the same way.


# Each turn, assemble the tools the model is allowed to see:
def tools_for_turn(user_message: str) -> list[ExecutableTool]:
    gateway = [search_capabilities_tool(catalog), invoke_tool_tool(catalog)]
    top_k = [
        executable
        for hit in catalog.search(user_message, 3)  # BM25: the 3 most relevant tools
        if (executable := catalog.get_executable(hit.tool_id)) is not None
    ]
    return [*gateway, *top_k]
```

`search_capabilities_tool` and `invoke_tool_tool` return plain `ExecutableTool` objects (`id`, `name`, `description`, `input_schema`, `output_schema`, `execute`). Wrap each one in your framework's tool type and run your normal loop. There are two dispatch paths, and getting them right matters because a registered executor may be sync or async:

- **Catalog tools** (your top-K hits): dispatch through `catalog.invoke(tool_id, args)`. It awaits coroutines only when needed and records the `invoke_*` trace events. Never `await` a raw `execute` yourself, or a sync handler raises.
- **The two gateway tools** (`search_capabilities` / `invoke_tool`): they are *not* catalog entries, and they own `async` handlers, so await `t.execute(args)` directly.

With Pydantic AI, the catalog-tool wrapper is:

```python
from pydantic_ai import Tool

def catalog_tool(catalog: ToolCatalog, t: ExecutableTool) -> Tool:
    async def fn(**kwargs):
        return await catalog.invoke(t.id, kwargs)  # handles sync/async + trace events
    fn.__name__ = t.id
    # Tool.from_schema builds a tool from a JSON schema directly — exactly what a dynamic catalog needs.
    return Tool.from_schema(fn, name=t.id, description=t.description, json_schema=t.input_schema)
```

A complete runnable agent that wires both paths into a Pydantic AI `Agent` lives in [`examples/pydantic-ai/`](../../../examples/pydantic-ai/README.md).

## `ToolCatalog`

The catalog is the registry plus an executor per tool. The methods you will use:

```python
catalog = ToolCatalog()

catalog.register(tool)                      # ExecutableTool: metadata + execute
catalog.search(query, top_k)                # → list[SearchHit]  (.tool_id, .score), BM25-ranked
catalog.has(tool_id)                        # → bool
catalog.get(tool_id)                        # → Tool | None            (metadata only)
catalog.get_executable(tool_id)             # → ExecutableTool | None  (metadata + execute)
await catalog.invoke(tool_id, args)         # run the handler, return its result
```

`invoke` calls the handler, awaits it only if it returned a coroutine (so sync and async executors both work), and re-raises whatever it throws after recording an `invoke_error` trace event. `search` defaults to `origin="direct"`; pass `catalog.search(query, k, "agent")` to tag a search as model-initiated in telemetry.

### `search_capabilities_tool` / `invoke_tool_tool`: the agent gateway

These wrap a catalog into two tools an agent can call itself. Hand them to your loop and the model gets self-service access to the whole catalog without it living in the prompt.

```python
search = search_capabilities_tool(catalog)  # id == "search_capabilities"
invoke = invoke_tool_tool(catalog)          # id == "invoke_tool"
```

**`search_capabilities({query, topKTools?, topKSkills?})`** returns two independently-ranked buckets, so a relevant skill is never crowded out by matching tools (result keys are camelCase, a wire contract shared with the TypeScript SDK and MCP):

```jsonc
{
  "tools": {
    "groups": [
      {
        "server": {"name": "fs"},                    // grouped by server (the id prefix before "__")
        "hits": [
          {"toolId": "fs__read_file", "score": 1.42, "description": "...", "inputSchema": {}}
        ]
      }
    ]
  },
  "skills": [{"skillId": "deploy-vercel", "score": 0.9, "description": "..."}]
}
```

`topKTools` defaults to 5 and `topKSkills` to 3, each clamped to `[1, 50]`. The `skills` bucket is always present and stays empty until you pass a [`SkillCatalog`](#skillcatalog-reusable-playbooks-on-demand).

**`invoke_tool({toolId, args})`** runs `catalog.invoke(tool_id, args)` and returns the tool's result. Arguments go *nested* under `args`. On a bad call it returns a structured `{"error": ..., "isError": True}` instead of raising, so a model mistake (unknown id, malformed args, a handler that throws) stays recoverable inside the loop rather than crashing the host.

> **Upgrading from 0.1.x?** `search_tools_tool` (id `search_tools`) is still exported as a deprecated, tools-only shim that keeps its original `{"groups": ...}` result shape. Migrate to `search_capabilities_tool`; see [`ratel_ai/gateway_compat.py`](ratel_ai/gateway_compat.py).

## `ToolRegistry`: ranking without execution

Need only the ranking, and you will dispatch tool calls yourself? `ToolRegistry` is the metadata-only BM25 index underneath `ToolCatalog`, with no executors and no gateway. It takes positional metadata rather than a dataclass:

```python
from ratel_ai import ToolRegistry

registry = ToolRegistry()
registry.register(
    "read_file",
    "read_file",
    "Read a file from local disk and return its textual contents.",
    {"properties": {"path": {"type": "string"}}},
    {"properties": {"contents": {"type": "string"}}},
)

registry.search("read a text file", 5)
# → [SearchHit(tool_id="read_file", score=1.42), ...]
```

## `SkillCatalog`: reusable playbooks, on demand

Skills are Markdown playbooks (a deploy runbook, a debugging checklist) ranked by a *separate* BM25 corpus from tools. Pass a `SkillCatalog` as the second argument to `search_capabilities_tool` and search returns the `skills` bucket alongside `tools`, each with its own result budget so a relevant skill is never starved by matching tools. The agent pulls a skill's full body into context on demand via `get_skill_content_tool` (id `get_skill_content`).

A skill can also declare the `tools` its instructions call: when the skill matches a query, those tools are pulled into the `tools` bucket (additively, deduped) so the agent gets the playbook *and* the tools it needs in one turn instead of a second search.

```python
from ratel_ai import Skill, SkillCatalog, get_skill_content_tool, search_capabilities_tool

skills = SkillCatalog()
skills.register(
    Skill(
        id="vercel-deploy",
        name="vercel-deploy",
        description="How to deploy to Vercel: env vars, preview vs production, rollbacks.",
        tags=["deploy", "ship to production"],      # indexed for ranking
        tools=["vercel__deploy", "fs__read_file"],  # surfaced alongside the skill when it matches
        metadata={"stacks": ["next", "vercel"]},    # non-indexed context for higher-layer ranking
        body="## Deploying to Vercel\n1. ...",       # returned by get_skill_content_tool
    )
)

search = search_capabilities_tool(catalog, skills)  # 2nd arg → result gains a populated `skills` bucket
load = get_skill_content_tool(skills)               # id == "get_skill_content"
```

Only `id`, `name`, and `description` are required; `tags`, `tools`, `metadata`, and `body` are optional. `get_skill_content({skillId})` returns `{"body": ...}`, or `{"error": ..., "isError": True}` for an unknown id.

## `register_mcp_server`: ingest an MCP server

Requires the `mcp` extra. The caller owns the `ClientSession` lifecycle (set it up with `async with`) and passes the initialized session in. `register_mcp_server` lists the upstream's tools, registers each under a namespaced id (`<name>__<tool>`), and wires its executor to the upstream `call_tool`.

```python
from ratel_ai import register_mcp_server

handle = await register_mcp_server(
    catalog,
    name="github",
    session=session,            # an initialized mcp.ClientSession you own
    transport_label="stdio",    # recorded on the upstream_register trace event
)
# handle.tool_ids           → ["github__create_issue", ...]
# handle.server_instructions → whatever you passed as `instructions`
# catalog.search / catalog.invoke now rank and run the upstream tools alongside local ones.
```

The caller-owns-the-session split is the one deliberate divergence from the TypeScript SDK, whose `registerMcpServer` reads the server instructions and transport label from the live handshake itself. Pass `instructions=` and `transport_label=` from your `await session.initialize()` result to make the emitted `upstream_register` event byte-identical across the two SDKs.

## Telemetry

Pass `trace` to `ToolCatalog` to capture every search / invoke / gateway / upstream / auth event into a sink owned by the Rust core ([ADR 0009](../../../docs/adr/0009-trace-events-core-owned-schema.md)). The default is no-op: nothing is captured unless you opt in.

```python
from ratel_ai import ToolCatalog, TraceSinkConfig

catalog = ToolCatalog(
    trace=TraceSinkConfig(kind="jsonl", session_id="session-1", path="/tmp/ratel.jsonl"),
)
# every catalog.invoke, search_capabilities_tool, and register_mcp_server call now writes
# one JSON line per event to /tmp/ratel.jsonl.
```

Sink kinds:
- `kind="noop"`, drop everything (default).
- `kind="memory"`, `session_id`, keep events in memory; drain via `catalog.drain_trace_events()`. Useful in tests.
- `kind="jsonl"`, `session_id`, `path`, append one JSON line per event to `path` (mode `0600` on Unix). Best-effort, lossy on backpressure; see [ADR 0009](../../../docs/adr/0009-trace-events-core-owned-schema.md) for the reliability profile.

`search_capabilities_tool` tags its emitted `search` event with `origin="agent"`; direct callers (`catalog.search(query, k)`) default to `"direct"`. Override per call via `catalog.search(query, k, "agent")`.

## Usage analytics

This is **Level 2**: ship one *usage rollup* per agent interaction to Ratel's cloud — the exact shape the dashboard renders. A rollup carries token spend broken down by the five context sources, plus what Ratel selection saved and what it *could* save. The token / savings / cost maths live in `ratel-ai-core` (native); the SDK is a thin client that assembles and ships. Needs the `observability` extra (`pip install 'ratel-ai[observability]'`) and an API key from the dashboard. Design: [ADR-0013](../../../docs/adr/0013-observability-and-analytics.md).

```bash
export RATEL_API_KEY="rtl-..."                  # from the dashboard; absent → no-op, never raises
export RATEL_HOST="https://cloud.ratel.sh"      # optional; this is the default
```

Call `track(...)` once per interaction. Give the per-source spend either as exact counts (`tokens_by_category`) or as raw `context` the SDK token-counts for you (see below); everything else is optional. `input_tokens` defaults to the sum of the per-source spend, and `cost_usd` is estimated in-core from `model` + tokens when omitted:

```python
from ratel_ai import get_client, RatelClient

get_client().track(
    tokens_by_category={"skills": 120, "tools": 2000, "history": 3400,
                        "memory": 260, "user_input": 340},
    saved_by_category={"tools": 7200},      # optional: kept out of the prompt this run
    saveable_by_category={"tools": 7000},   # optional: could save in observe-only mode
    model="claude-sonnet-4-6", output_tokens=180, latency_ms=420,  # cost_usd auto-estimated
)
get_client().flush()   # also auto-flushed at process exit
```

**No exact counts? Pass raw `context` instead.** Hand `track()` what you already have — the system/skills text, the tools list, the prior messages, the retrieved memory, the user's turn — and the SDK token-counts each source for you (no manual `estimate_tokens`). Strings count directly, lists element-wise, dicts as compact JSON. Explicit `tokens_by_category` wins if you pass both:

```python
get_client().track(
    context={
        "skills": SYSTEM_PROMPT,       # str
        "tools": tools,                # the tools list, counted as-is
        "history": messages,           # the prior turns
        "memory": retrieved_memory,
        "user_input": user_message,
    },
    model="gpt-4o", output_tokens=resp.usage.completion_tokens,
)
```

The five context sources are exactly `skills, tools, history, memory, user_input`. Export is background, batched, and best-effort — it never blocks or breaks your app (overflow drops, retries on 5xx, gives up quietly when the cloud is unreachable). `get_client()` returns a process-wide, env-configured `RatelClient`; construct your own `RatelClient(...)` to override config.

**Ratel savings from the catalog.** Pass `observe=True` to `ToolCatalog` and every search records the tokens its top-K selection keeps out of the prompt (full catalog vs selected) onto `last_savings` and the local trace stream — ready to fold into a `track()` call as `saved_by_category` / `saveable_by_category`:

```python
catalog = ToolCatalog(observe=True)
catalog.search("read a file from disk", top_k=2)
catalog.last_savings   # → {"full_catalog_tokens": ..., "selected_tokens": ..., "tokens_saved": ...}
```

A runnable end-to-end demo — BM25 suggestions plus a backfilled adoption story shipped via `track()` — lives in [`examples/observability_demo.py`](examples/README.md).

## Develop

This package is part of the Cargo workspace at the repo root and builds into a local venv. From `src/sdk/python/`:

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv maturin pytest pytest-asyncio ruff mypy
.venv/bin/maturin develop        # build the native extension into the venv
.venv/bin/pytest                 # run tests
.venv/bin/ruff check .           # lint
.venv/bin/mypy ratel_ai          # type-check
```

## Layout

```
native/         PyO3 binding to ratel-ai-core (cdylib Cargo workspace member)
ratel_ai/       pure-Python SDK: catalog, gateway tools, skills, MCP ingestion
  observability/  lean cloud analytics — usage rollups via RatelClient.track
examples/       runnable demos (observability_demo.py)
tests/          pytest suite
pyproject.toml  maturin build backend + tooling config
```

The native crate is a member of the top-level Cargo workspace, so `cargo build --workspace` picks it up automatically.
