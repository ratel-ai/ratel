<div align="center">
  <h1>Ratel — Dynamic MCP Tool Selection & Context Engineering for AI Agents</h1>
  <p>Fix MCP tool overload. Cut LLM token usage by up to 82%. No vector DB, no embeddings.</p>

  <p>
    <a href="https://docs.ratel.sh">Docs</a> •
    <a href="https://github.com/ratel-ai/skills">Skills</a> •
    <a href="./docs/roadmap.md">Roadmap</a> •
    <a href="https://discord.gg/hdKpx69NR">Discord</a>
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@ratel-ai/sdk"><img src="https://img.shields.io/npm/v/@ratel-ai/sdk?label=npm&color=cb3837" alt="npm" /></a>
    <a href="https://crates.io/crates/ratel-ai-core"><img src="https://img.shields.io/crates/v/ratel-ai-core?label=crates.io&color=e57300" alt="crates.io" /></a>
    <a href="https://github.com/ratel-ai/ratel/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel?style=social" alt="GitHub stars" /></a>
    <a href="./LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
  </p>
</div>

<div align="center">
  <img src="./docs/assets/hero.webp" width="960" alt="Ratel — dynamic MCP tool selection and context engineering for AI agents" />
</div>

> **MCP tool overload is costing you tokens and accuracy.** Most agents stuff every tool into context on every turn. Ratel sits between your agent and its catalog — dynamically selecting only the tools that matter for *this* turn via in-process BM25 retrieval. No vector DB. No embeddings. No service to deploy.

## Proof: what the numbers say

| Model + catalog size | Accuracy | Token reduction | Cost reduction |
|---|---|---|---|
| Local model (qwen3.5), pool=100 | **8% → 77%** (+69 pp) | — | — |
| OSS cloud (glm-5.1), pool=180 | **+12 pp** | **−85%** | — |
| Frontier (Sonnet 4.6), pool=180 | ≈parity | **−82%** | **−68%** |
| Frontier (Opus 4.6), pool=180 | **+8 pp** | **−72%** | — |

Full methodology and per-pool breakdown in [ratel-ai/ratel-bench › RESULTS.md](https://github.com/ratel-ai/ratel-bench/blob/main/RESULTS.md).

## Quickstart

Pick your language — same Rust core under each:

**TypeScript**

```bash
pnpm add @ratel-ai/sdk
```

```ts
import { ToolCatalog, searchCapabilitiesTool, invokeToolTool } from "@ratel-ai/sdk";

const catalog = new ToolCatalog();
catalog.register({
  id: "read_file",
  name: "read_file",
  description: "Read a file from local disk.",
  inputSchema: { properties: { path: { type: "string" } } },
  outputSchema: { properties: { contents: { type: "string" } } },
  execute: async ({ path }) => ({ contents: await fs.readFile(path, "utf8") }),
});

// Two tools replace your full catalog in the agent loop.
// The agent calls search_capabilities to find tools, invoke_tool to run them.
const search = searchCapabilitiesTool(catalog);
const invoke = invokeToolTool(catalog);
```

- End-to-end Vercel AI SDK: [examples/ai-sdk/](examples/ai-sdk/README.md)
- Ingest an upstream MCP server: [registerMcpServer](src/sdk/ts/README.md#registermcpserver--index-an-mcp-servers-tools-into-the-catalog)
- Full SDK reference: [src/sdk/ts/README.md](src/sdk/ts/README.md)

**Python**

```bash
pip install ratel-ai
```

```python
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

search = search_capabilities_tool(catalog)
invoke = invoke_tool_tool(catalog)
```

- End-to-end Pydantic AI: [examples/pydantic-ai/](examples/pydantic-ai/README.md)
- Full SDK reference: [src/sdk/python/README.md](src/sdk/python/README.md)

**Rust**

```bash
cargo add ratel-ai-core
```

See [src/core/lib/README.md](src/core/lib/README.md) and [docs.rs/ratel-ai-core](https://docs.rs/ratel-ai-core).

## What is MCP tool selection?

When you give an AI agent a large MCP tool catalog, every tool's schema lands in the context window on every turn. At 30+ tools you're burning thousands of tokens per call. At 100+ tools, local models begin failing to select correctly — accuracy degrades to near zero.

**MCP tool selection** means the agent only sees the tools relevant to its current task — resolved dynamically at inference time, not hardcoded. Ratel does this with an in-process BM25 index over a schema-aware text projection of every tool in your catalog. The agent calls `search_capabilities(query)` and gets back the top-K hits. The full catalog never enters the model's context.

This is also called **tool RAG** — retrieval-augmented generation applied to the tool layer rather than the document layer. Like RAG for MCP, but without the vector database.

## Reduce LLM token usage and fix MCP tool overload

Ratel addresses **context rot** — the gradual degradation of agent quality as irrelevant tools, stale history, and accumulated context crowd out what actually matters for the current turn.

- **No vector DB.** BM25 is deterministic — same query, same results, every time. No embedding model, no inference latency on the retrieval path, no service to run.
- **~2 tools per turn** in replace-by-default mode. The agent's tool list at any turn is the top-K hits only ([ADR-0003](docs/adr/0003-tool-selection-replace-vs-suggest.md)).
- **In-process.** Pre-built native bindings for macOS, Linux, and Windows — no Rust toolchain to install.
- **Framework-agnostic.** Works with Vercel AI SDK, Pydantic AI, or any agent loop. Or expose the catalog over MCP.

## When to use Ratel

| Your situation | Ratel's value |
|---|---|
| Local model + large catalog (30+ tools) | **Critical.** Baseline collapses at scale — Ratel keeps it working. |
| Open-source cloud + large catalog | **Strong win.** +12 pp accuracy, −85% tokens. |
| Frontier model + large catalog | **Cost-driven win.** −82% tokens, −68% cost at near-parity accuracy. |
| Claude Code / Cursor + many MCP servers | **Drop-in proxy.** Use `@ratel-ai/mcp-server` as a gateway. No code changes. |
| Any model + small catalog (≤30 tools) | Skip Ratel — the pool fits in the prompt cleanly. |

## Drop Ratel between Claude Code and your existing MCP servers

No agent code changes. Ratel acts as a proxy that selects which upstream tools to forward for each turn:

```bash
npx -y @ratel-ai/mcp-server mcp import   # interactive migration wizard
```

Full docs, install options, and OAuth gateway setup: [`ratel-ai/ratel-mcp`](https://github.com/ratel-ai/ratel-mcp)

## Integrate via the skills suite (fastest path)

Five Claude Code / Cursor / Codex skills that integrate Ratel, set up observability, and audit your codebase:

```bash
npx skills add ratel-ai/skills --all
```

Or paste this into your coding agent:

```text
Run npx skills add ratel-ai/skills --all and use the skills to integrate Ratel in this project.
```

Want a free, static assessment first — no engagement required?

```text
Run npx skills add ratel-ai/skills --all and use the skills to assess the agents in this codebase and show me where Ratel would help.
```

Full suite: [`ratel-ai/skills`](https://github.com/ratel-ai/skills)

## How it works

```
Agent turn
  │
  ├─ search_capabilities("write tests for the auth module")
  │    └─ BM25 over schema-aware text projections of 200 tools
  │         └─ returns top-3: [run_tests, read_file, write_file]
  │
  └─ invoke_tool("run_tests", { path: "auth/" })
       └─ executes locally or proxies to upstream MCP server
```

- **BM25 retrieval** over a deterministic, schema-aware text projection of each tool. No embeddings, no model on the retrieval path ([ADR-0004](docs/adr/0004-bm25-tool-indexing.md)).
- **Replace-by-default.** The agent's tool list at every turn is the top-K hits, nothing else.
- **Unified catalog.** Local executables + upstream MCP servers' tools share the same ranked surface. The model sees one coherent interface.

## The Ratel project

Three repos, one story:

| | Repo | What it is |
|---|---|---|
| **Library** | [`ratel-ai/ratel`](https://github.com/ratel-ai/ratel) (this one) | The engine. Rust core + TS SDK + Python SDK. Embed in your agent process. |
| **Showcase** | [`ratel-ai/ratel-mcp`](https://github.com/ratel-ai/ratel-mcp) | `@ratel-ai/mcp-server` — MCP proxy with OAuth gateway, Claude Code / Cursor / ChatGPT support. |
| **Proof** | [`ratel-ai/ratel-bench`](https://github.com/ratel-ai/ratel-bench) | MetaTool agent benchmark + ToolRet retrieval harness. Source of all numbers above. |

## SDKs

| | Rust | TypeScript | Python | CLI |
|---|---|---|---|---|
| **Install** | `cargo add ratel-ai-core` | `pnpm add @ratel-ai/sdk` | `pip install ratel-ai` | `pnpm add -g @ratel-ai/cli` |
| **Hero call** | `ToolRegistry::search` | `searchCapabilitiesTool(catalog)` | `search_capabilities_tool(catalog)` | `ratel inspect` |
| **Docs** | [src/core/lib/](src/core/lib/README.md) | [src/sdk/ts/](src/sdk/ts/README.md) | [src/sdk/python/](src/sdk/python/README.md) | [src/integrations/cli/](src/integrations/cli/README.md) |

## Examples

- [examples/ai-sdk/](examples/ai-sdk/README.md) — Vercel AI SDK with pre-filter + dynamic gateway
- [examples/mcp-chat/](examples/mcp-chat/README.md) — Vercel AI SDK REPL ingesting an upstream MCP server
- [examples/pydantic-ai/](examples/pydantic-ai/README.md) — Pydantic AI (Python) with pre-filter + dynamic gateway

## Roadmap

Tool selection is the wedge, not the destination. Same catalog, same retrieval engine, same in-process runtime — expanding across the full context surface:

- **v0.1.x** (now) — tool selection, BM25 retrieval, MCP proxy, TypeScript + Python SDKs, telemetry, skills
- **v0.2.x** — chat management: store, compact, prune, and navigate long histories
- **v0.3.x** — memories: prior decisions, preferences, and artifacts ranked into the current turn
- **v0.4.x** — context graph: unified tools-skills-memories substrate

Dated milestones: [docs/roadmap.md](docs/roadmap.md) · Full thesis: [docs/overview.md](docs/overview.md)

## Repo layout

```
src/
├── core/lib/           # ratel-ai-core — Rust crate; BM25 retrieval engine
├── sdk/ts/             # @ratel-ai/sdk — TypeScript SDK (NAPI-bound)
├── sdk/python/         # ratel-ai — Python SDK (PyO3-bound)
└── integrations/
    └── cli/            # @ratel-ai/cli — ratel CLI (telemetry; transitional MCP verbs)
examples/               # Runnable end-to-end examples
docs/                   # Overview, roadmap, ADRs
```

Sibling repos: [`ratel-ai/ratel-mcp`](https://github.com/ratel-ai/ratel-mcp) · [`ratel-ai/ratel-bench`](https://github.com/ratel-ai/ratel-bench)

## Build & test

Prerequisites: Rust stable (pinned via `rust-toolchain.toml`), Node 24+, pnpm 10.28+. Python SDK: Python 3.9+ and [`uv`](https://docs.astral.sh/uv/).

```bash
# Rust
cargo build --workspace
cargo test --workspace

# TypeScript
pnpm install && pnpm -r build && pnpm -r test

# Python (from src/sdk/python/)
uv venv --python 3.11 .venv
uv pip install --python .venv maturin pytest pytest-asyncio ruff mypy
.venv/bin/maturin develop && .venv/bin/pytest
```

CI runs all three pipelines on every PR (`.github/workflows/{rust,ts,python}.yml`).

## Architecture decisions

- [ADR-0002 — TS↔Rust binding via NAPI-RS](docs/adr/0002-ts-rust-binding-strategy.md)
- [ADR-0003 — Tool selection: replace by default, suggest opt-in](docs/adr/0003-tool-selection-replace-vs-suggest.md)
- [ADR-0004 — BM25 tool indexing strategy](docs/adr/0004-bm25-tool-indexing.md)
- [ADR-0006 — Benchmark corpus and eval modes](docs/adr/0006-benchmark-corpus-and-eval-modes.md)
- [ADR-0011 — Python↔Rust binding via PyO3](docs/adr/0011-python-rust-binding-strategy.md)

## Contributing

- Humans: [CONTRIBUTING.md](CONTRIBUTING.md)
- Coding agents: [AGENTS.md](AGENTS.md)
- LLM index of docs: [llms.txt](llms.txt)

## License

MIT. Free to use, modify, and redistribute. See [LICENSE.md](LICENSE.md).
