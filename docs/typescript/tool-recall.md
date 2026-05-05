# Tool Recall (TypeScript)

Auto-discover relevant tools each turn — no manual query needed.

## When to Use Recall

Use `.recall()` when:
- You have many registered tools and want Agentified to pick the right ones automatically
- You want tools to stick across turns without manual turn capture
- You want the tool set to evolve as the conversation changes topics

Without recall, you'd use `.tools()` with an explicit tool map or wire up `discoverTool` yourself.

## Basic Usage

```typescript
const ctx = await session.context
  .recall()
  .messages({ strategy: "recent", maxTokens: 4000 })
  .assemble();

console.log(ctx.recalled.tools);
// [{ name: "get_weather", score: 0.94, ... }, ...]
```

`.recall()` with no arguments defaults to `{ tools: true }` — up to 5 tools, no minimum similarity threshold.

## Configuration

```typescript
const ctx = await session.context
  .recall({ tools: { limit: 10, minSimilarity: 0.7 } })
  .messages({ strategy: "compacted", maxTokens: 4000 })
  .assemble();
```

### `RecallConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `tools` | `boolean \| RecallToolsConfig` | `true` (when `.recall()` called) | Enable/configure tool recall |

### `RecallToolsConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `limit` | `number` | `5` | Max tools returned |
| `minSimilarity` | `number` | none | Minimum score for newly discovered tools |

Omit `.recall()` entirely to skip recall (messages only).

## Working with Recalled Tools

```typescript
for (const tool of ctx.recalled.tools) {
  console.log(`${tool.name} (score: ${tool.score})`);
}
```

### `RankedTool` fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Tool name |
| `description` | `string` | Tool description |
| `parameters` | `object` | JSON Schema for inputs |
| `score` | `number` | `1.0` = sticky from previous turn, `<1.0` = newly discovered |
| `graphExpanded` | `boolean?` | `true` if auto-injected via graph expansion |

## Token Budgeting

```typescript
const ctx = await session.context
  .recall({ tools: { limit: 10 } })
  .messages({ strategy: "compacted", maxTokens: 4000 })
  .limitTokens(8000)
  .assemble();
```

`.limitTokens()` caps the combined budget for tools + messages. Recalled tool tokens are subtracted first, the remainder goes to messages. Without `.limitTokens()`, they're budgeted independently.

## Full Example: Multi-Turn Agent Loop

```typescript
import { Agentified } from "agentified";

const ag = new Agentified();
await ag.connect("http://localhost:9119");

const dataset = await ag.dataset("support-bot").register({
  tools: [
    { name: "search_kb", description: "Search knowledge base", parameters: { type: "object", properties: { query: { type: "string" } } }, handler: async (args) => ({ results: [] }) },
    { name: "get_account", description: "Get account details by ID", parameters: { type: "object", properties: { id: { type: "string" } } }, handler: async (args) => ({ id: args.id, plan: "pro" }) },
    { name: "create_ticket", description: "Create a support ticket", parameters: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } } }, handler: async (args) => ({ ticketId: "T-123" }) },
    // ... 50 more tools
  ],
});

const session = dataset.session("chat-456");

// Turn 1: user asks about billing
await session.updateConversation({
  messages: [{ role: "user", content: "Why was I charged twice this month?" }],
});

const ctx1 = await session.context
  .recall({ tools: { limit: 5 } })
  .messages({ strategy: "recent", maxTokens: 4000 })
  .limitTokens(8000)
  .assemble();

// ctx1.recalled.tools → [get_account, search_kb, ...] (billing-relevant)

// ... LLM generates response, you persist it ...
await session.updateConversation({
  messages: [{ role: "assistant", content: "Let me look into your account." }],
});

// Turn 2: user follows up
await session.updateConversation({
  messages: [{ role: "user", content: "Can you open a ticket for this?" }],
});

const ctx2 = await session.context
  .recall({ tools: { limit: 5 } })
  .messages({ strategy: "recent", maxTokens: 4000 })
  .limitTokens(8000)
  .assemble();

// ctx2.recalled.tools → [get_account, search_kb, create_ticket, ...]
// get_account and search_kb persist from turn 1 (score 1.0)
// create_ticket is newly discovered based on "open a ticket"
```

## See Also

- [Getting Started](./getting-started.md) — SDK quick start
- [Tool Recall (Server)](../server/tool-recall.md) — API details, internals, session stickiness
- [Chat Management](../server/chat-management.md) — Message strategies and token budgets
- [Session Continuity](../server/session-continuity.md) — Manual turn-based alternative
