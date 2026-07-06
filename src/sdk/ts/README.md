<div align="center">
  <h1>@ratel-ai/sdk</h1>
  <h4>TypeScript SDK for Ratel — drop context engineering into any TS / Node agent with one dependency.</h4>

  <p>
    <a href="../../../docs/">Docs</a> •
    <a href="https://discord.gg/hdKpx69NR">Discord</a>
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@ratel-ai/sdk"><img src="https://img.shields.io/npm/v/@ratel-ai/sdk?label=npm&color=cb3837" alt="npm" /></a>
    <a href="https://github.com/ratel-ai/ratel/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel?style=social" alt="GitHub stars" /></a>
    <a href="https://discord.gg/hdKpx69NR"><img src="https://img.shields.io/discord/1478702964003705015?logo=discord&logoColor=white&color=7289da&label=discord" alt="Discord" /></a>
    <a href="../../../LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
  </p>
</div>

As an agent runs, its context window fills with tool definitions it will never call this turn. A model staring at 100 tools picks the wrong one, burns tokens on schemas it ignores, and drifts. **Ratel** keeps the full toolset out of the prompt and surfaces only the handful that matter for the current turn.

`@ratel-ai/sdk` is the TypeScript surface of [Ratel](../../../README.md). It bundles the Rust core (`ratel-ai-core`) via [NAPI-RS](https://napi.rs), so a JS / TS agent gets ranked tool selection by adding one dependency, **in-process, no API key, no service to deploy, no Rust toolchain.** Retrieval is BM25 over a schema-aware text projection of each tool: deterministic, with no embeddings, no vector DB, and no inference cost on the retrieval path.

## Install

```bash
pnpm add @ratel-ai/sdk
# or
npm install @ratel-ai/sdk
```

Prebuilt native bindings ship for darwin-arm64, darwin-x64, linux-x64-gnu, linux-arm64-gnu, and win32-x64-msvc. The right per-platform binary is selected automatically through npm `optionalDependencies` ([ADR 0006](../../../docs/adr/0006-native-ffi-bindings.md)), so there is nothing to compile.

## How it works

Everything starts with a **`ToolCatalog`**: register each of your tools once, pairing its metadata (id, description, JSON schemas) with the handler that runs it. From there you reach the model in one of two ways, and most agents use both at once:

- **Pre-filter (top-K).** Before each model call, ask the catalog for the few tools most relevant to the user's message and put *those* in the tool list. The full catalog never enters the prompt. This is Ratel's replace-by-default tool injection ([ADR 0004](../../../docs/adr/0004-retrieval-and-tool-selection.md)).
- **Dynamic gateway.** Give the agent two always-present tools, `search_capabilities` (find more tools by description) and `invoke_tool` (run one by id), so it can reach the rest of the catalog on its own when the pre-filtered set is not enough.

The two compose: the pre-filter covers the common case in the prompt, and the gateway is the escape hatch for everything else. Tools can be local functions, an upstream MCP server's tools (via [`registerMcpServer`](#registermcpserver-ingest-an-mcp-servers-tools)), or both. The model sees one unified, ranked surface.

## Quickstart

Register a catalog, then build each turn's tool list from the gateway plus the top-K hits for the user's message.

```ts
import {
  ToolCatalog,
  searchCapabilitiesTool,
  invokeToolTool,
  type ExecutableTool,
} from "@ratel-ai/sdk";
import { readFile } from "node:fs/promises";

const catalog = new ToolCatalog();
catalog.register({
  id: "read_file",
  name: "read_file",
  description: "Read a file from local disk and return its textual contents.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "absolute path to the file" } },
    required: ["path"],
  },
  outputSchema: { type: "object", properties: { contents: { type: "string" } } },
  execute: async ({ path }) => ({ contents: await readFile(path, "utf8") }),
});
// ...register the rest of your tools the same way.

// Each turn, assemble the tools the model is allowed to see:
function toolsForTurn(userMessage: string): ExecutableTool[] {
  const gateway = [searchCapabilitiesTool(catalog), invokeToolTool(catalog)];
  const topK = catalog
    .search(userMessage, 3) // BM25: the 3 most relevant tools for this message
    .map((hit) => catalog.getExecutable(hit.toolId))
    .filter((t): t is ExecutableTool => t !== undefined);
  return [...gateway, ...topK];
}
```

`searchCapabilitiesTool` and `invokeToolTool` return plain `ExecutableTool` objects (`{ id, name, description, inputSchema, outputSchema, execute }`). Wrap each one in your framework's tool type, a few lines, and run your normal loop. For the Vercel AI SDK that adapter is:

```ts
import { tool, jsonSchema } from "ai";

const toAISDKTool = (t: ExecutableTool) =>
  tool({
    description: t.description,
    inputSchema: jsonSchema(t.inputSchema),
    execute: t.execute,
  });
```

A complete runnable agent that wires this into `ToolLoopAgent` lives in [`examples/ai-sdk/`](../../../examples/ai-sdk/README.md); [`examples/mcp-chat/`](../../../examples/mcp-chat/README.md) does the same over an upstream MCP server.

## `ToolCatalog`

The catalog is the registry plus an executor per tool. The methods you will use:

```ts
const catalog = new ToolCatalog();

catalog.register(tool);              // ExecutableTool: metadata + execute()
catalog.search(query, topK);         // → SearchHit[]  ({ toolId, score }), BM25-ranked
catalog.has(toolId);                 // → boolean
catalog.get(toolId);                 // → Tool | undefined            (metadata only)
catalog.getExecutable(toolId);       // → ExecutableTool | undefined  (metadata + execute)
await catalog.invoke(toolId, args);  // run the handler, return its result
```

`invoke` awaits async executors and rethrows whatever the handler throws (after recording an `invoke_error` trace event), so failures surface where you call it. `search` defaults to `origin: "direct"`; pass `catalog.search(query, k, "agent")` to tag a search as model-initiated in telemetry.

### `searchCapabilitiesTool` / `invokeToolTool`: the agent gateway

These wrap a catalog into two tools an agent can call itself. Hand them to your loop and the model gets self-service access to the whole catalog without it living in the prompt.

```ts
const search = searchCapabilitiesTool(catalog); // id: "search_capabilities"
const invoke = invokeToolTool(catalog);         // id: "invoke_tool"
```

**`search_capabilities({ query, topKTools?, topKSkills? })`** returns two independently-ranked buckets, so a relevant skill is never crowded out by matching tools:

```jsonc
{
  "tools": {
    "groups": [
      {
        "server": { "name": "fs" },                  // grouped by server (the id prefix before "__")
        "hits": [
          { "toolId": "fs__read_file", "score": 1.42, "description": "...", "inputSchema": {} }
        ]
      }
    ]
  },
  "skills": [{ "skillId": "deploy-vercel", "score": 0.9, "description": "..." }]
}
```

`topKTools` defaults to 5 and `topKSkills` to 3, each clamped to `[1, 50]`. The `skills` bucket is always present and stays empty until you pass a [`SkillCatalog`](#skillcatalog-reusable-playbooks-on-demand).

**`invoke_tool({ toolId, args })`** runs `catalog.invoke(toolId, args)` and returns the tool's result. Arguments go *nested* under `args`. On a bad call it returns a structured `{ error, isError: true }` instead of throwing, so a model mistake (unknown id, malformed args, a handler that throws) stays recoverable inside the loop rather than crashing the host.

> **Upgrading from 0.1.x?** `searchToolsTool` (id `search_tools`) is still exported as a deprecated, tools-only shim that keeps its original `{ groups }` result shape. Migrate to `searchCapabilitiesTool`; see [`src/gateway-compat.ts`](src/gateway-compat.ts).

## `ToolRegistry`: ranking without execution

Need only the ranking, and you will dispatch tool calls yourself? `ToolRegistry` is the metadata-only BM25 index underneath `ToolCatalog`, with no executors and no gateway.

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

registry.search("read a text file", 5);
// → [{ toolId: "read_file", score: 1.42 }, ...]
```

## `SkillCatalog`: reusable playbooks, on demand

Skills are Markdown playbooks (a deploy runbook, a debugging checklist) ranked by a *separate* BM25 corpus from tools. Pass a `SkillCatalog` as the second argument to `searchCapabilitiesTool` and search returns the `skills` bucket alongside `tools`, each with its own result budget so a relevant skill is never starved by matching tools. The agent pulls a skill's full body into context on demand via `getSkillContentTool` (id `get_skill_content`).

A skill can also declare the `tools` its instructions call: when the skill matches a query, those tools are pulled into the `tools` bucket (additively, deduped) so the agent gets the playbook *and* the tools it needs in one turn instead of a second search.

```ts
import {
  SkillCatalog,
  searchCapabilitiesTool,
  getSkillContentTool,
  type Skill,
} from "@ratel-ai/sdk";

const skills = new SkillCatalog();
skills.register({
  id: "vercel-deploy",
  name: "vercel-deploy",
  description: "How to deploy to Vercel: env vars, preview vs production, rollbacks.",
  tags: ["deploy", "ship to production"],     // indexed for ranking
  tools: ["vercel__deploy", "fs__read_file"], // surfaced alongside the skill when it matches
  metadata: { stacks: ["next", "vercel"] },   // non-indexed context for higher-layer ranking
  body: "## Deploying to Vercel\n1. ...",      // returned by getSkillContentTool
});

const search = searchCapabilitiesTool(catalog, skills); // 2nd arg → result gains a populated `skills` bucket
const load = getSkillContentTool(skills);               // id: "get_skill_content"
```

Only `id`, `name`, and `description` are required; `tags`, `tools`, `metadata`, and `body` are optional (parity with the Python SDK). `get_skill_content({ skillId })` returns `{ body }`, or `{ error, isError: true }` for an unknown id.

## `registerMcpServer`: ingest an MCP server's tools

Hand the catalog a connected MCP transport and Ratel calls `tools/list`, registers each upstream tool under a server-namespaced id (`<name>__<toolName>`), and wires its executor to `tools/call` over the same connection. Use any [transport from `@modelcontextprotocol/sdk`](https://modelcontextprotocol.io): stdio, Streamable HTTP, or SSE.

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

// handle.toolIds            → ["fs__echo", "fs__add", ...]
// handle.serverInstructions → the upstream's instructions, if any
// catalog.search / catalog.invoke now rank and run the upstream tools alongside local ones.

await handle.close(); // disconnect on shutdown
```

Errors from the upstream `tools/call` propagate as rejected promises from `catalog.invoke`, so they slot into the same handling as local executors. Mix as many servers and local tools into one catalog as you like; the model still sees a single ranked surface.

## Telemetry

Pass `trace` to the `ToolCatalog` constructor to capture every search / invoke / gateway / upstream / auth event into a sink owned by the Rust core ([ADR 0007](../../../docs/adr/0007-telemetry-two-streams.md)). The default is no-op: nothing is captured unless you opt in.

```ts
const catalog = new ToolCatalog({
  trace: { kind: "jsonl", sessionId: "session-1", path: "/tmp/ratel.jsonl" },
});
// every catalog.invoke, searchCapabilitiesTool, and registerMcpServer call now writes
// one JSON line per event to /tmp/ratel.jsonl.
```

Sink kinds:
- `{ kind: "noop" }`, drop everything (default).
- `{ kind: "memory"; sessionId }`, keep events in memory; drain via `catalog.drainTraceEvents()`. Useful in tests.
- `{ kind: "jsonl"; sessionId; path }`, append one JSON line per event to `path` (mode `0600` on Unix). Best-effort, lossy on backpressure; see [ADR 0007](../../../docs/adr/0007-telemetry-two-streams.md) for the reliability profile.

`searchCapabilitiesTool` tags its emitted `search` event with `origin: "agent"`; direct callers (`catalog.search(query, k)`) default to `"direct"`. Override per call via `catalog.search(query, k, "agent")`.

### OpenTelemetry export

Independently of the local sink above, the SDK **emits OpenTelemetry spans** for the same funnel — `execute_tool`, `ratel.search`, `ratel.skill.load`, `ratel.upstream.register`, `ratel.auth.flow` (the `gen_ai.*` / `ratel.*` vocabulary). This is transparent: spans go to whatever OpenTelemetry provider is registered, and are a no-op until one is. Two ways to turn export on:

```ts
import { configureTelemetry } from "@ratel-ai/sdk";

// Greenfield: ship the SDK's spans to Ratel Cloud (needs the optional
// @ratel-ai/telemetry-otlp peer). RATEL_URL or { endpoint } sets the destination.
const handle = await configureTelemetry({ apiKey: process.env.RATEL_API_KEY });
// ... later: await handle.shutdown();
```

If you already run OpenTelemetry (Langfuse, the Vercel AI SDK, your own collector), **skip `configureTelemetry`** — the spans already flow to your provider — and add `ratelSpanProcessor` from `@ratel-ai/telemetry-otlp` to dual-export the Ratel cut to Cloud. Message/tool content (`ratel.search.query`, tool args/result) rides span attributes only when `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` selects a span mode (`SPAN_ONLY` or `SPAN_AND_EVENT`); it is off by default, and `EVENT_ONLY` does not put content on spans.

## Package shape

- Package name: `@ratel-ai/sdk` (ESM, entry `dist/index.js`); the underlying NAPI loader is CJS, statically bridged at build time.
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
