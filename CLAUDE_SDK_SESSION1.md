# Task: Build @agentified/sdk TypeScript Package (Session 1)

## Context

Build the TypeScript SDK for Agentified, a tool discovery service. The Rust server exists in `core/`. See issue #8 for the full v1 spec (check the latest comment for consolidated API).

## Your Task

Create `@agentified/sdk` in `packages/sdk/`:

### API to Implement

```typescript
import { Agentified, tool } from "@agentified/sdk";

// Initialize
const agentified = new Agentified({
  serverUrl: "http://localhost:3030",
});

// Define + register tools
const searchTool = tool({ name: "search", description: "...", inputSchema: {...} });
await agentified.register([searchTool, emailTool]);

// Mode 1: prefetch (before agent step)
const { tools } = await agentified.prefetch({
  messages: conversationHistory,
  topK: 10,
});

// Mode 2: discover (agent calls this)  
const discoverTool = agentified.asDiscoverTool();
// Supports: { query: "..." } or { queries: ["...", "..."] }
```

### Server Endpoints (in `core/src/main.rs`)

```
POST /api/v1/tools     - Register tools
GET  /api/v1/tools     - List tools
POST /api/v1/discover  - Discover (body: { query, top_k })
GET  /health           - Health check
```

### Scope

✅ Package setup (tsup, vitest)
✅ `tool()` helper
✅ `Agentified` class
✅ `register()`, `prefetch()`, `asDiscoverTool()`
✅ Tests against running server

❌ Sidecar mode (Session 2)
❌ Binary download (Session 2)

### File Structure

```
packages/sdk/
├── package.json
├── tsup.config.ts
├── src/
│   ├── index.ts
│   ├── types.ts
│   ├── tool.ts
│   ├── agentified.ts
│   └── __tests__/
└── README.md
```

## Start

1. Read `core/src/main.rs` for exact API contract
2. Read issue #8 (especially latest comment) for full spec
3. Implement and test
