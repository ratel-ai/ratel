<div align="center">
  <h1>ratel-ai</h1>
  <h4>Python SDK for Ratel — drop context engineering into any Python agent with one dependency.</h4>

  <p>
    <a href="../../../docs/">Docs</a> •
    <a href="../../../docs/roadmap.md">Roadmap</a> •
    <a href="https://discord.gg/hdKpx69NR">Discord</a>
  </p>
</div>

Python SDK for [Ratel](../../../README.md). Bundles `ratel-ai-core` (Rust) via [PyO3](https://pyo3.rs) so Python agents can drop Ratel in with one dependency — no Rust toolchain, no service to deploy.

Binding strategy is locked in [ADR 0011](../../../docs/adr/0011-python-rust-binding-strategy.md); it mirrors the TypeScript SDK's NAPI binding ([ADR 0002](../../../docs/adr/0002-ts-rust-binding-strategy.md)).

## Install

```bash
pip install ratel-ai
# upstream MCP ingestion (register_mcp_server) needs the extra:
pip install 'ratel-ai[mcp]'
```

Prebuilt `abi3` wheels ship for darwin-arm64, darwin-x64, linux-x64-gnu, linux-arm64-gnu, and win32-x64-msvc — no Rust toolchain required to install. The base SDK runs on CPython ≥ 3.9; the `mcp` extra requires ≥ 3.10.

## Usage

The SDK exposes two layers, both framework-neutral — the Python mirror of the [TypeScript SDK](../ts/README.md).

### `ToolRegistry` — metadata-only BM25 index

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

hits = registry.search("read a text file", 5)
# [SearchHit(tool_id="read_file", score=1.42), ...]
```

### `ToolCatalog` + gateway tools — register once, dispatch by id

`ToolCatalog` extends the registry with executable handlers (`id → execute`), and
`search_capabilities_tool` / `invoke_tool_tool` give your agent a self-service gateway
over the catalog. Pair them with any agent framework — see
[`examples/pydantic-ai/`](../../../examples/pydantic-ai/README.md) for a Pydantic AI wiring.

```python
import asyncio
from ratel_ai import ToolCatalog, ExecutableTool, search_capabilities_tool, invoke_tool_tool

catalog = ToolCatalog()
catalog.register(
    ExecutableTool(
        id="read_file",
        name="read_file",
        description="Read a file from local disk.",
        input_schema={"properties": {"path": {"type": "string"}}},
        output_schema={"properties": {"contents": {"type": "string"}}},
        execute=lambda args: {"contents": open(args["path"]).read()},
    )
)

search = search_capabilities_tool(catalog)   # id == "search_capabilities"
invoke = invoke_tool_tool(catalog)    # id == "invoke_tool"
```

Executors may be sync or async; `ToolCatalog.invoke` awaits coroutines automatically.

### `SkillCatalog` + `get_skill_content_tool` — reusable playbooks, on demand

Skills are Markdown playbooks ranked by a *separate* BM25 corpus. When a `SkillCatalog`
is passed to `search_capabilities_tool`, the search returns a `skills` bucket alongside
`tools` — each with its own result budget, so a relevant skill is never crowded out by
matching tools. The agent loads a skill's full body on demand via `get_skill_content_tool`.

```python
from ratel_ai import Skill, SkillCatalog, get_skill_content_tool, search_capabilities_tool

skills = SkillCatalog()
skills.register(
    Skill(
        id="vercel-deploy",
        name="vercel-deploy",
        description="How to deploy to Vercel: env vars, preview vs production, rollbacks.",
        triggers=["deploy", "ship to production"],
        stacks=["next", "vercel"],
    )
)

search = search_capabilities_tool(catalog, skills)  # result: {"tools": {...}, "skills": [...]}
load = get_skill_content_tool(skills)               # id == "get_skill_content"
```

### `register_mcp_server` — ingest an upstream MCP server

Requires the `mcp` extra. The caller owns the `ClientSession` lifecycle (set it up
with `async with`) and passes the initialized session in:

```python
from ratel_ai import register_mcp_server

handle = await register_mcp_server(
    catalog, name="github", session=session, transport_label="stdio",
)
# handle.tool_ids -> ["github__create_issue", ...]
```

### Telemetry

Pass `trace` to `ToolCatalog` to capture every search / invoke / gateway / upstream / auth event into a sink owned by the Rust core ([ADR 0009](../../../docs/adr/0009-trace-events-core-owned-schema.md)). Default is no-op — nothing is captured unless you opt in.

```python
from ratel_ai import ToolCatalog, TraceSinkConfig

catalog = ToolCatalog(
    trace=TraceSinkConfig(kind="jsonl", session_id="session-1", path="/tmp/ratel.jsonl"),
)
# every catalog.invoke, search_capabilities_tool, register_mcp_server call now writes
# one JSON line per event to /tmp/ratel.jsonl.
```

Sink kinds:
- `kind="noop"` — drop everything (default).
- `kind="memory"`, `session_id` — keep events in memory; drain via `catalog.drain_trace_events()`. Useful for tests.
- `kind="jsonl"`, `session_id`, `path` — append one JSON line per event to `path` (mode `0600` on Unix). Best-effort, lossy on backpressure — see ADR-0009 for the reliability profile.

`search_capabilities_tool` tags its emitted `search` event with `origin="agent"`; direct callers (`catalog.search(query, k)`) default to `"direct"`. Override per call via `catalog.search(query, k, "agent")`.

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
ratel_ai/       pure-Python SDK: catalog, gateway tools, MCP ingestion
tests/          pytest suite
pyproject.toml  maturin build backend + tooling config
```

The native crate is a member of the top-level Cargo workspace, so `cargo build --workspace` picks it up automatically.
