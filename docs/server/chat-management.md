# Chat Management

How Agentified manages conversation context — message strategies, token budgets, summarization, and history navigation.

## The Problem

Long conversations exceed LLM context windows. Sending all messages every turn wastes tokens and increases cost. Manually trimming history loses context. Agentified's context assembly solves this automatically.

## Message Strategies

Control how conversation history is assembled via `.messages({ strategy })`:

| Strategy | Behavior | Requires LLM |
|----------|----------|--------------|
| `recent` (default) | Most recent messages fitting in token budget | No |
| `full` | All messages from oldest, up to token budget | No |
| `recent+summary` | LLM summary of older messages (40% budget) + recent messages (60% budget) | Yes |
| `summary` | LLM-generated summary of entire conversation | Yes |

```typescript
const ctx = await session.context
  .messages({ strategy: "recent+summary", maxTokens: 4000 })
  .assemble();
```

### How `recent+summary` Works

1. Budget is split: 60% for recent messages, 40% for summary
2. Recent messages are selected from newest, fitting within the recent budget
3. Older messages (before the recent window) are sent to the LLM for summarization
4. The SDK constructs a summary message and injects it into the messages array
5. Result: `[keepFirst?, summary, ...recentMessages]`

### Summary Message Construction

When a summary is generated, the SDK constructs a message with:
- `role: "assistant"` — natural for LLM conversation flow
- `content`: annotated with seq range, e.g. `[Summary of messages 2–85 (84 messages compacted)]\n<summary text>`
- `id: "summary"`, `seq: 0` — identifiable as a synthetic message

The annotation tells the agent that older messages exist and can be retrieved via `getMessagesTool`.

### Fallback

If the LLM summary call fails (timeout, API error), the server falls back to `recent` strategy. The response includes `fallback: true` so you can detect this.

### Response Fields

```typescript
ctx.summary        // raw summary text (no annotation), undefined if no summary
ctx.summaryRange   // { firstSeq, lastSeq, count } — which messages were summarized
ctx.fallback       // true if LLM failed and fell back to recent
```

## First-Message Preservation (`keepFirst`)

Opt-in: always include the first user message regardless of token budget.

```typescript
const ctx = await session.context
  .messages({ strategy: "recent", maxTokens: 4000, keepFirst: true })
  .assemble();
// ctx.messages[0] → always the first user message (original prompt)
```

Useful for preserving the user's original intent in long conversations. Only looks for `role: "user"` messages. No effect on `full` strategy (which already starts from the beginning). If no user messages exist, behaves like `keepFirst: false`.

When combined with `recent+summary`, the first user message appears before the summary:
```
[first user message] → [summary of messages 2–85] → [recent messages 86–100]
```

## Token Budgeting

### Message Budget

`.messages({ maxTokens: 4000 })` caps the token budget for conversation messages. Token estimation uses `content.length / 4`.

### Global Budget

`.limitTokens(8000)` caps total assembly (tools + messages). Tool token cost is subtracted first, remainder goes to messages.

Example: `limitTokens=8000`, recalled tools use 2000 tokens, `maxTokens=4000` → effective message budget = `min(8000-2000, 4000) = 4000`.

## Navigating Compacted History (`getMessagesTool`)

When messages are summarized or excluded, the agent can navigate the full history via `getMessagesTool` — an LLM-callable tool wrapping `GET /api/v1/messages`.

```typescript
// Available on session, included in prepareStep automatically
session.getMessagesTool

// Agent calls it with:
// { afterSeq: 0, limit: 20 }    → first 20 messages
// { aroundSeq: 50, limit: 10 }  → messages around seq 50
// { limit: 20 }                  → last 20 messages (default)
```

The summary annotation (`[Summary of messages 2–85...]`) signals to the agent that it can use `getMessagesTool` to retrieve the compacted messages.

## Examples

### Basic: Recent Strategy

```typescript
const session = instance.session("chat-1");
await session.updateConversation({ messages: [{ role: "user", content: userMessage }] });

const ctx = await session.context
  .messages({ strategy: "recent", maxTokens: 4000 })
  .assemble();

const response = await llm.chat(ctx.messages);
```

### Long Conversation: Summary + keepFirst

```typescript
const ctx = await session.context
  .messages({ strategy: "recent+summary", maxTokens: 4000, keepFirst: true })
  .assemble();

// ctx.messages:
// [0] first user message (original prompt)
// [1] "[Summary of messages 2–85 (84 messages compacted)]\n..."
// [2..] recent messages (86–100)

if (ctx.fallback) {
  console.warn("Summary generation failed, using recent messages only");
}
```

### Mastra Integration

```typescript
const ctx = await session.context
  .tools({ agentified_discover: session.discoverTool })
  .messages({ strategy: "recent+summary", maxTokens: 4000, keepFirst: true })
  .assemble();

const result = await agent.generate(ctx.messages, {
  prepareStep: ctx.prepareStep,
  maxSteps: 10,
});
// prepareStep includes agentified_discover + agentified_get_messages
```

## See Also

- [Architecture](./architecture.md) — Full system design
- [Session Continuity](./session-continuity.md) — Turn tracking and tool boosting
- [Hybrid Ranking](./ranking.md) — How tool scores are computed
- [REST API](./api.md) — Endpoint reference
