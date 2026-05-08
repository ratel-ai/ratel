<div align="center">
  <h1>@ratel-ai/sdk</h1>
  <h4>TypeScript SDK for Ratel — drop context engineering into any TS / Node agent with one dependency.</h4>

  <p>
    <a href="../../../docs/">Docs</a> •
    <a href="../../../docs/roadmap.md">Roadmap</a> •
    <a href="https://discord.gg/hdKpx69NR">Discord</a>
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@ratel-ai/sdk"><img src="https://img.shields.io/npm/v/@ratel-ai/sdk?label=npm&color=cb3837" alt="npm" /></a>
    <a href="https://github.com/ratel-ai/ratel/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel?style=social" alt="GitHub stars" /></a>
    <a href="https://discord.gg/hdKpx69NR"><img src="https://img.shields.io/discord/1478702964003705015?logo=discord&logoColor=white&color=7289da&label=discord" alt="Discord" /></a>
    <a href="../../../LICENSE.md"><img src="https://img.shields.io/badge/license-ELv2-blue" alt="license" /></a>
  </p>
</div>

TypeScript SDK for [Ratel](../../../README.md). Bundles `ratel-ai-core` (Rust) via NAPI-RS so JS/TS agents can drop Ratel in with one dependency — no Rust toolchain, no service to deploy.

## Install

```bash
pnpm add @ratel-ai/sdk
# or
npm install @ratel-ai/sdk
```

From `0.1.4`, prebuilt native bindings ship for darwin-arm64, darwin-x64, linux-x64-gnu, linux-arm64-gnu, and win32-x64-msvc — no Rust toolchain required to install. The right per-platform binary is selected automatically via npm `optionalDependencies`. See [ADR 0002](../../../docs/adr/0002-ts-rust-binding-strategy.md) for the rationale.

## Usage

The SDK exposes two layers, both framework-neutral.

### `ToolRegistry` — metadata-only BM25 index

Use this when you just need ranking and you'll dispatch tool calls yourself.

```ts
import { ToolRegistry, type Tool } from "@ratel-ai/sdk";

const registry = new ToolRegistry();
registry.register({
  id: "read_file",
  name: "read_file",
  description: "Read a file from local disk and return its textual contents.",
  inputSchema: { properties: { path: { type: "string" } } },
  outputSchema: { properties: { contents: { type: "string" } } },
});

const hits = registry.search("read a text file", 5);
// [{ toolId: "read_file", score: 1.42 }, ...]
```

### `ToolCatalog` + gateway tools — register once, dispatch by id

`ToolCatalog` extends the registry with executable handlers (`id → execute`), and `searchToolsTool` / `invokeToolTool` give your agent a self-service gateway over the catalog. Pair them with any agent framework — see [`examples/ai-sdk/`](../../../examples/ai-sdk/README.md) for a Vercel AI SDK wiring.

```ts
import {
  ToolCatalog,
  searchToolsTool,
  invokeToolTool,
  type ExecutableTool,
} from "@ratel-ai/sdk";

const catalog = new ToolCatalog();
catalog.register({
  id: "read_file",
  name: "read_file",
  description: "Read a file from local disk.",
  inputSchema: { properties: { path: { type: "string" } } },
  outputSchema: { properties: { contents: { type: "string" } } },
  execute: async ({ path }) => ({ contents: await fs.readFile(path, "utf8") }),
});

// Gateway tools — wrap them into your framework's tool type.
// Each returns ExecutableTool ({ id, name, description, inputSchema, outputSchema, execute }).
const search = searchToolsTool(catalog);
const invoke = invokeToolTool(catalog);
```

Tool injection (replace vs suggest, [ADR 0003](../../../docs/adr/0003-tool-selection-replace-vs-suggest.md)) is layered on later when the SDK exposes a higher-level adapter.

### `registerMcpServer` — index an MCP server's tools into the catalog

Hand the catalog a connected MCP transport and Ratel will call `tools/list`, register each upstream tool with a server-namespaced id (`<name>__<toolName>`), and wire its executor to `tools/call` over the same connection. Use any [transport from `@modelcontextprotocol/sdk`](https://modelcontextprotocol.io) — stdio, Streamable HTTP, or SSE.

```ts
import { ToolCatalog, registerMcpServer } from "@ratel-ai/sdk";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const catalog = new ToolCatalog();
const handle = await registerMcpServer(catalog, {
  name: "fs",
  transport: new StdioClientTransport({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"],
  }),
});

// handle.toolIds → ["fs__echo", "fs__add", ...]
// catalog.search / catalog.invoke now see the upstream tools alongside any local ones.

await handle.close(); // disconnect on shutdown
```

Errors from the upstream `tools/call` propagate as rejected promises from `catalog.invoke`, so they slot into the same handling as local executors.

### Telemetry

Pass `trace` to the `ToolCatalog` constructor to capture every search / invoke / gateway / upstream / auth event into a sink owned by the Rust core ([ADR 0009](../../../docs/adr/0009-trace-events-core-owned-schema.md)). Default is no-op — nothing is captured unless you opt in.

```ts
const catalog = new ToolCatalog({
  trace: { kind: "jsonl", sessionId: "session-1", path: "/tmp/ratel.jsonl" },
});
// every catalog.invoke, searchToolsTool, registerMcpServer call now writes
// one JSON line per event to /tmp/ratel.jsonl.
```

Sink kinds:
- `{ kind: "noop" }` — drop everything (default).
- `{ kind: "memory"; sessionId }` — keep events in memory; drain via `catalog.drainTraceEvents()`. Useful for tests.
- `{ kind: "jsonl"; sessionId; path }` — append one JSON line per event to `path` (mode `0600` on Unix). Best-effort, lossy on backpressure — see ADR-0009 for the reliability profile.

`searchToolsTool` tags its emitted `search` event with `origin: "agent"`; pre-fetch helpers (`catalog.search(query, k)`) default to `"user"`. Override per call via `catalog.search(query, k, "agent")`.

## Package shape

- Package name: `@ratel-ai/sdk`
- ESM entry (`dist/index.js`); the underlying NAPI loader is CJS, statically bridged at build time.
- Native binding lives in [`native/`](native/README.md) (Rust + NAPI-RS).

## Build & test

Part of the pnpm workspace at the repo root. From this folder:

```bash
pnpm build:native   # cargo + napi → native/{*.node, index.cjs, index.d.cts}
pnpm build:ts       # tsc → dist/
pnpm build          # both
pnpm typecheck
pnpm lint           # biome
pnpm test           # vitest (rebuilds native first)
```

Or run against the whole workspace from the repo root with `pnpm -r <script>`.
