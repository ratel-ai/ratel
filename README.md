<div align="center">
  <h1>Ratel</h1>
  <p>Your AI agent is paying for tools it never uses. Ratel fixes that.</p>

  <p>
    <a href="https://docs.ratel.sh">Docs</a> •
    <a href="https://github.com/ratel-ai/skills">Skills</a> •
    <a href="https://discord.gg/75vAPdjYqT">Discord</a>
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@ratel-ai/sdk"><img src="https://img.shields.io/npm/v/@ratel-ai/sdk?label=npm&color=cb3837" alt="npm" /></a>
    <a href="https://crates.io/crates/ratel-ai-core"><img src="https://img.shields.io/crates/v/ratel-ai-core?label=crates.io&color=e57300" alt="crates.io" /></a>
    <a href="https://github.com/ratel-ai/ratel/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel?style=social" alt="GitHub stars" /></a>
    <a href="#license"><img src="https://img.shields.io/badge/license-Apache--2.0%20%26%20MIT-blue" alt="license" /></a>
  </p>
</div>

<div align="center">
  <img src="./docs/assets/hero.webp" width="960" alt="Ratel hero animation" />
</div>

## Introduction

The context engineering layer for AI agents. Selects only the tools and skills relevant to each turn, recovering accuracy lost to tool overload and cutting what you pay per call. No vector DB, no embeddings.

## Why

- **Cost:** Every tool schema sent to the model is tokens you pay for. Fewer tools in context means lower spend on every call.
- **Accuracy:** Models get worse as tool lists grow. Some drop from 77% to 8% accuracy just from having too many options.
- **Ratel fixes both:** by indexing your full catalog and injecting only the tools that match the current task, keeping the rest out of context entirely.

Across local, open-source, and frontier model setups, Ratel cuts token usage and recovers accuracy lost to tool overload — without embeddings or a vector DB. Full results: [benchmark.ratel.sh](https://benchmark.ratel.sh)

## Install

**Building an agent in TypeScript or Python?** Add the SDK:

```bash
pnpm add @ratel-ai/sdk
```
```bash
pip install ratel-ai
```

<details>
<summary>TypeScript example</summary>

```ts
import { ToolCatalog, searchCapabilitiesTool, invokeToolTool } from "@ratel-ai/sdk";

const catalog = new ToolCatalog();
catalog.register({
  id: "read_file",
  name: "read_file",
  description: "Read a file from local disk.",
  inputSchema: { properties: { path: { type: "string" } } },
  execute: async ({ path }) => ({ contents: await fs.readFile(path, "utf8") }),
});

const search = searchCapabilitiesTool(catalog);
const invoke = invokeToolTool(catalog);
```

</details>

<details>
<summary>Python example</summary>

```python
from ratel_ai import ToolCatalog, ExecutableTool, search_capabilities_tool, invoke_tool_tool

catalog = ToolCatalog()
catalog.register(ExecutableTool(
  id="read_file",
  name="read_file",
  description="Read a file from local disk.",
  input_schema={"properties": {"path": {"type": "string"}}},
  execute=lambda args: {"contents": open(args["path"]).read()},
))

search = search_capabilities_tool(catalog)
invoke = invoke_tool_tool(catalog)
```

</details>

Examples: [Vercel AI SDK](examples/ai-sdk/README.md) · [Pydantic AI](examples/pydantic-ai/README.md)

---

**Using Claude Code, Cursor, or ChatGPT with MCP servers?** Drop Ratel in front of your existing setup with no code changes:

```bash
npx -y @ratel-ai/mcp-server mcp import
```

Full docs: [ratel-ai/ratel-mcp](https://github.com/ratel-ai/ratel-mcp)

## How it works

When your agent needs to act, it calls `search_capabilities`. Ratel searches its internal index and returns only the most relevant tools. The model sees a short, focused list and picks correctly far more often.

The index uses BM25, the same algorithm behind most search engines, applied to each tool's name and description. It is fast, deterministic, and adds no latency to your agent loop.

[Full docs](https://docs.ratel.sh)

## The Ratel project

Ratel scales from an in-process library to a managed service — one engine, one catalog contract, all the way up:

| | Repo | What it is |
|---|---|---|
| **Engine + platform** | [ratel-ai/ratel](https://github.com/ratel-ai/ratel) (this one) | The `ratel-ai-core` engine plus TS/Python SDKs, the [`protocol/`](protocol/README.md) catalog-source contract, and the OTel telemetry helpers. Embed it in your agent process today. |
| **ratel-local** | [ratel-ai/ratel-mcp](https://github.com/ratel-ai/ratel-mcp) | The local distribution — Ratel in front of your MCP setup, today shipped as `ratel-mcp` / `@ratel-ai/mcp-server`. |
| **ratel-cloud** | *coming* | Managed Ratel: the first hosted catalog source plus intelligence. SDKs reach it via `RATEL_URL` over the catalog-source contract. |
| **ratel-bench** | [ratel-ai/ratel-bench](https://github.com/ratel-ai/ratel-bench) | The benchmark harness behind [benchmark.ratel.sh](https://benchmark.ratel.sh). |

The hosted cloud is decided direction ([ADR-0002](docs/adr/0002-product-split-engine-local-cloud.md)), not yet public; a standalone server is deferred ([ADR-0003](docs/adr/0003-catalog-source-interface.md)).

## Repo layout

```
src/
├── core/              # ratel-ai-core — Rust BM25 engine
├── sdk/ts/            # @ratel-ai/sdk — TypeScript SDK (NAPI-bound)
├── sdk/python/        # ratel-ai — Python SDK (PyO3-bound)
└── telemetry/         # OTel conventions + helper packages
protocol/              # catalog-source wire contract
examples/              # End-to-end SDK examples
docs/                  # ADRs
```

## Build & test

Prerequisites: Rust stable, Node 24+, pnpm 10.28+. Python SDK: Python 3.9+ and [`uv`](https://docs.astral.sh/uv/).

```bash
cargo build --workspace && cargo test --workspace   # Rust
pnpm install && pnpm -r build && pnpm -r test       # TypeScript
# Python: see src/sdk/python/README.md
```

## Contributing

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [AGENTS.md](AGENTS.md) — for coding agents working in this repo

## License

The `ratel-ai-core` engine is licensed under [Apache-2.0](LICENSE-APACHE) — an explicit patent grant for the engine others embed. Everything else (SDKs, telemetry helpers, examples) is [MIT](LICENSE.md). See [ADR-0009](docs/adr/0009-licensing.md) for the rationale.
