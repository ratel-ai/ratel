<div align="center">
  <h1>Ratel</h1>
  <p>Your AI agent is paying for tools it never uses. Ratel fixes that.</p>

  <p>
    <a href="https://docs.ratel.sh">Docs</a> •
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

## Introduction

The context engineering layer for AI agents. Dynamically selects only the tools relevant to each turn, [cutting token usage by 82%](https://github.com/ratel-ai/ratel-bench/blob/main/RESULTS.md) and recovering accuracy lost to tool overload. No database. No embeddings. Runs in-process.

## Why

- **Cost:** Every tool schema sent to the model is tokens you pay for. Fewer tools in context means lower spend on every call.
- **Accuracy:** Models get worse as tool lists grow. Some drop from 77% to 8% accuracy just from having too many options.
- **Ratel fixes both:** by indexing your full catalog and injecting only the tools that match the current task, keeping the rest out of context entirely.

**Try it in 60 seconds** with the [Ratel skill suite](https://github.com/ratel-ai/skills#quickstart----paste-this-into-your-coding-agent).

| Setup | Accuracy | Token reduction | Cost reduction |
|---|---|---|---|
| Local model, 100+ tools | 8% to 77% | n/a | n/a |
| Open-source cloud, 180 tools | +12 pp | 85% less | n/a |
| Claude / GPT-4, 180 tools | roughly the same | 82% less | 68% less |
| Claude Opus, 180 tools | +8 pp | 72% less | n/a |

Full benchmark details: [ratel-ai/ratel-bench](https://github.com/ratel-ai/ratel-bench/blob/main/RESULTS.md)

## Install

**Building an agent in TypeScript or Python?** Add the SDK:

```bash
pnpm add @ratel-ai/sdk    # or: pip install ratel-ai
```

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

[More detail](docs/overview.md)

## Roadmap

- **Now** -- tool selection, TypeScript + Python SDKs, MCP proxy, telemetry
- **Next** -- conversation management: summarise and prune long histories
- **Later** -- memories: surface relevant past decisions each turn
- **Further** -- full context layer: tools, memories, and skills unified

[Full roadmap](docs/roadmap.md)

## The Ratel project

| | Repo | What it is |
|---|---|---|
| **Library** | [ratel-ai/ratel](https://github.com/ratel-ai/ratel) (this one) | The engine. Embed it in your agent. |
| **Server** | [ratel-ai/ratel-mcp](https://github.com/ratel-ai/ratel-mcp) | MCP proxy for Claude Code, Cursor, and ChatGPT. No code changes needed. |
| **Proof** | [ratel-ai/ratel-bench](https://github.com/ratel-ai/ratel-bench) | The benchmark harness behind every number in the table above. |
