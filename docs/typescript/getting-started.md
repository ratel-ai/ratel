# Getting Started (TypeScript)

Register 200 tools. Get the 5 that matter. **86% fewer tokens, same accuracy.**

## Prerequisites

- **Docker** (to run agentified-core)
- **Node.js 18+** and **pnpm**
- **`OPENAI_API_KEY`** — for `text-embedding-3-small` embeddings

## 1. Start the server

```bash
docker run -p 9119:9119 -e OPENAI_API_KEY=sk-... agentified/agentified-core
```

Verify:

```bash
curl http://localhost:9119/health
# {"status":"ok"}
```

## 2. Install

```bash
pnpm add agentified
```

## 3. Paste and run

Create `index.ts`:

```typescript
import { Agentified } from "agentified";

const ag = new Agentified();
await ag.connect("http://localhost:9119");

const dataset = await ag.dataset("my-agent").register({
  tools: [
    {
      name: "get_weather",
      description: "Get current weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      handler: async (args) => ({ temp: 22, city: args.city }),
    },
    {
      name: "search_docs",
      description: "Search documentation by keyword",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      handler: async (args) => ({ results: [] }),
    },
  ],
});

const session = dataset.session("demo");

// Assemble context — tools + messages for this turn
const ctx = await session.context
  .messages({ strategy: "recent" })
  .assemble();
console.log("Assembled tools:", Object.keys(ctx.tools));
console.log("Token estimate:", ctx.tokenEstimate);
```

Run:

```bash
pnpm tsx index.ts
```

> **Authenticated servers** (Cloud Run IAM, API gateways): pass headers to `connect()`:
> ```typescript
> await ag.connect("https://my-service.run.app", {
>   headers: { Authorization: `Bearer ${token}` },
> });
> ```

## 4. What happened

The server:

1. **Embedded** your query using `text-embedding-3-small`
2. **Scored** tools via weighted cosine similarity across name, description, and schemas
3. **Combined** with BM25 keyword matching: `final = 0.7 × semantic + 0.3 × BM25`
4. **Returned** the top-K tools sorted by relevance

Read [Architecture](../server/architecture.md) for the full deep dive.

## Next steps

- **[Mastra Integration](./integrations/mastra.md)** — Full-stack Mastra + React example
- **[Frontend Tools](./frontend-tools.md)** — Run tools in the browser
- **[SDK API Reference](../../src/ts-packages/sdk/README.md)** — Full TypeScript API
- **[ts-sdk-smoke example](../../examples/ts-sdk-smoke/)** — Runnable smoke test
- **[ts-mastra-smoke example](../../examples/ts-mastra-smoke/)** — Mastra + OpenAI smoke test
