# `@ratel-ai/sdk`

TypeScript SDK for [Ratel](../../../README.md) — the context engineering platform for AI agents. Bundles `ratel-core` (Rust) via NAPI-RS so JS/TS agents can drop Ratel in with one dependency.

## Install

```bash
pnpm add @ratel-ai/sdk
# or
npm install @ratel-ai/sdk
```

For v0.1.1 the package builds the native module from source on the host platform; consumers need a Rust toolchain (`rustup`). Per-OS prebuilt binaries land in a follow-up — see [ADR 0002](../../../docs/adr/0002-ts-rust-binding-strategy.md).

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
