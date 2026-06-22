<div align="center">
  <h1>Ratel</h1>
  <p>Your AI agent is spending too much money. Ratel fixes that.</p>

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
  <img src="./docs/assets/hero.webp" width="960" alt="Ratel hero animation" />
</div>

## What is Ratel?

Ratel is an open-source library that makes AI agents cheaper, faster, and more accurate by controlling what they see on every turn.

Most AI agents work by giving the model a list of every tool it could possibly use — every time, on every message. The more tools you have, the more you pay, and the worse the model gets at picking the right one. Ratel sits in the middle and only shows the model the tools that are actually relevant right now.

No external service. No database. Drop it into your existing agent in a few lines of code.

## Why it matters

Every time your AI agent responds, it reads its entire list of tools — even the ones it will never use for that task. If you have 50 tools, it reads all 50. If you have 200, it reads all 200. You pay for every token it reads, and the longer that list gets, the more the model starts making mistakes.

Ratel fixes this by figuring out which 2–3 tools are relevant to the current task and only showing those. The rest stay out of the context entirely.

**What that means in practice:**

- **Lower API costs.** Up to 68% less spend on the same workload, because you're sending far fewer tokens per request.
- **Better accuracy.** Models make fewer mistakes when they're not overwhelmed by irrelevant options. Local and open-source models improve dramatically.
- **No new infrastructure.** Ratel runs inside your existing process. There's no vector database to set up, no embedding model to run, no server to manage.

## The numbers

| Your setup | Accuracy change | Cost change |
|---|---|---|
| Local model with 100+ tools | **8% → 77%** (without Ratel the model nearly always picks the wrong tool) | — |
| Open-source cloud model with 180 tools | **+12 percentage points** better | **−85% tokens** |
| Claude / GPT-4-class model with 180 tools | roughly the same accuracy | **−68% to −82% cost** |
| Claude Opus with 180 tools | **+8 percentage points** better | **−72% tokens** |

If you're using a frontier model like Claude or GPT-4, Ratel mostly pays for itself through cost reduction. If you're using a smaller or local model, it makes a huge accuracy difference too.

Full benchmark methodology: [ratel-ai/ratel-bench › RESULTS.md](https://github.com/ratel-ai/ratel-bench/blob/main/RESULTS.md)

## Install

There are three ways to use Ratel depending on your situation. Pick the one that fits:

---

**Option 1 — You're building an agent in TypeScript or Python**

Add the library directly to your project:

```bash
# TypeScript / Node
pnpm add @ratel-ai/sdk

# Python
pip install ratel-ai
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

// These two tools replace your full list in the agent loop.
const search = searchCapabilitiesTool(catalog);
const invoke = invokeToolTool(catalog);
```

Examples: [Vercel AI SDK](examples/ai-sdk/README.md) · [Pydantic AI](examples/pydantic-ai/README.md) · [MCP ingestion](examples/mcp-chat/README.md)

---

**Option 2 — You use Claude Code, Cursor, or ChatGPT with MCP servers**

Drop Ratel in front of your existing MCP setup with one command — no code changes needed:

```bash
npx -y @ratel-ai/mcp-server mcp import
```

This runs an interactive wizard that imports your current MCP configuration and sets Ratel as the proxy. Full docs: [`ratel-ai/ratel-mcp`](https://github.com/ratel-ai/ratel-mcp)

---

**Option 3 — You want an AI agent to integrate Ratel for you**

Install the skills suite and let your coding agent (Claude Code, Cursor, Codex) plan the integration:

```bash
npx skills add ratel-ai/skills --all
```

Then paste this prompt into your agent:

```
Run npx skills add ratel-ai/skills --all and use the skills to integrate Ratel in this project.
```

Or get a free assessment of where Ratel would help before committing:

```
Run npx skills add ratel-ai/skills --all and use the skills to assess the agents in this codebase and show me where Ratel would help.
```

---

## How it works

When your agent needs to act, instead of dumping 200 tools into the model's context, it calls `search_capabilities` with a description of what it's trying to do. Ratel searches its internal index and returns only the 2–3 most relevant tools. The model sees a short, focused list and picks correctly far more often.

Under the hood, the index uses BM25 — the same algorithm that powers search engines — applied to each tool's name, description, and input/output fields. It's deterministic (same query always returns the same results), runs in-process, and adds no latency to the retrieval path.

More detail: [docs/overview.md](docs/overview.md) · [ADR-0004: why BM25](docs/adr/0004-bm25-tool-indexing.md)

## The Ratel project

| | Repo | What it is |
|---|---|---|
| **Library** | [`ratel-ai/ratel`](https://github.com/ratel-ai/ratel) ← you are here | The core engine. Embed it in your agent. |
| **MCP proxy** | [`ratel-ai/ratel-mcp`](https://github.com/ratel-ai/ratel-mcp) | Drop-in proxy for Claude Code, Cursor, and ChatGPT — no code changes. |
| **Benchmarks** | [`ratel-ai/ratel-bench`](https://github.com/ratel-ai/ratel-bench) | The benchmark harness behind the numbers in the table above. |

## Roadmap

The first release focuses on tool selection. The plan is to expand to the rest of what ends up in an agent's context:

- **Now (v0.1.x)** — tool selection, TypeScript + Python SDKs, MCP proxy, telemetry
- **Next (v0.2.x)** — conversation management: summarise, prune, and navigate long chat histories
- **Later (v0.3.x)** — memories: surface relevant past decisions and preferences each turn
- **Further (v0.4.x)** — full context graph: tools, memories, and skills in one unified layer

Full roadmap: [docs/roadmap.md](docs/roadmap.md)

## Repo layout

```
src/
├── core/lib/           # Rust core — the BM25 retrieval engine
├── sdk/ts/             # TypeScript SDK
├── sdk/python/         # Python SDK
└── integrations/cli/   # ratel CLI (telemetry + transitional MCP verbs)
examples/               # Runnable end-to-end examples
docs/                   # Overview, roadmap, architecture decisions
```

## Build & test

Prerequisites: Rust stable, Node 24+, pnpm 10.28+. For the Python SDK: Python 3.9+ and [`uv`](https://docs.astral.sh/uv/).

```bash
# Rust
cargo build --workspace && cargo test --workspace

# TypeScript
pnpm install && pnpm -r build && pnpm -r test

# Python (from src/sdk/python/)
uv venv --python 3.11 .venv
uv pip install --python .venv maturin pytest pytest-asyncio ruff mypy
.venv/bin/maturin develop && .venv/bin/pytest
```

## Contributing

- Humans: [CONTRIBUTING.md](CONTRIBUTING.md)
- Coding agents working in this repo: [AGENTS.md](AGENTS.md)
- LLM index of the docs: [llms.txt](llms.txt)

## License

MIT — free to use, modify, and redistribute. See [LICENSE.md](LICENSE.md).
