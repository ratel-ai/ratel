<div align="center">
  <h1>@ratel-ai/sdk</h1>
  <p>Context engineering for TypeScript and Node.js agents.</p>

  <p>
    <a href="https://docs.ratel.sh">Docs</a> •
    <a href="https://github.com/ratel-ai/ratel">GitHub</a> •
    <a href="https://discord.gg/75vAPdjYqT">Discord</a>
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@ratel-ai/sdk"><img src="https://img.shields.io/npm/v/@ratel-ai/sdk?label=npm&color=cb3837" alt="npm" /></a>
    <a href="https://github.com/ratel-ai/ratel/stargazers"><img src="https://img.shields.io/github/stars/ratel-ai/ratel?style=social" alt="GitHub stars" /></a>
    <a href="https://github.com/ratel-ai/ratel/blob/main/LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
  </p>
</div>

`@ratel-ai/sdk` retrieves the tools and skills relevant to each agent turn instead of sending the full catalog to the model. It bundles Ratel's Rust engine in-process: BM25 by default, with local semantic and hybrid retrieval available when needed. No API key, vector database, or service is required. Installing a published package on a supported prebuilt target also requires no Rust toolchain.

Use `ToolCatalog` for ranked tools with executable handlers and `SkillCatalog` for ranked playbooks loaded on demand. Expose `searchCapabilitiesTool`, `invokeToolTool`, and `getSkillContentTool` so an agent can discover tools and skills, invoke tools, and load full skill instructions. Tools from existing MCP servers can be ingested into the tool catalog.

Semantic and hybrid retrieval use a configurable embedding model ([ADR 0012](../../../docs/adr/0012-configurable-embedding-models.md)), set per catalog via the `embedding` option: the built-in default, a HuggingFace repo or local directory (in-process), or an OpenAI-compatible endpoint (OpenAI, Ollama, TEI, vLLM).

Registration is always metadata-only. For semantic or hybrid retrieval, register the full corpus, then explicitly build and search asynchronously so model loading, HTTP, and inference never block Node's event loop:

```ts
const catalog = new ToolCatalog({ method: "semantic", embedding: { ollama: "nomic-embed-text" } });
catalog.registerMany(tools);
await catalog.buildEmbeddings();
const hits = await catalog.searchAsync("deploy the service", 5);
```

Use `await catalog.rebuildEmbeddings()` after changing the endpoint's model or vector dimension. Synchronous `search()` remains available for BM25 only.

## Install

```bash
pnpm add @ratel-ai/sdk
```

## Quickstart

Save as `quickstart.mjs`, then run `node quickstart.mjs`:

```js
import { ToolCatalog } from "@ratel-ai/sdk";

const catalog = new ToolCatalog();
catalog.register({
  id: "get_weather",
  name: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  outputSchema: {
    type: "object",
    properties: { forecast: { type: "string" } },
  },
  execute: ({ city }) => ({ forecast: `Sunny in ${city}` }),
});

const [hit] = catalog.search("What is the weather in Rome?", 1);
console.log(await catalog.invoke(hit.toolId, { city: "Rome" }));
```

Continue with the [TypeScript guide](https://docs.ratel.sh/docs/sdks/typescript), [capability tools](https://docs.ratel.sh/docs/capability-tools), [API reference](https://docs.ratel.sh/docs/api/sdk-typescript), or the [Vercel AI SDK example](https://github.com/ratel-ai/ratel/tree/main/examples/ai-sdk).

Telemetry export is optional. With `@ratel-ai/telemetry-otlp` installed, `configureTelemetry()` reads `RATEL_URL` and `RATEL_API_KEY`, wires the exporter, and returns a shutdown handle. See the [telemetry guide](https://docs.ratel.sh/docs/telemetry).

Package layout: `src/` is the TypeScript surface, `native/` contains the NAPI binding, `npm/` holds platform packages, and tests live beside their source. From the repository root, run `pnpm --filter @ratel-ai/sdk... build` and `pnpm --filter @ratel-ai/sdk test`.
