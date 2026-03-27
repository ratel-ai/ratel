# Tool Recall

How Agentified automatically discovers relevant tools each turn using the last user message, with session-aware stickiness.

## The Problem

Stateless tool discovery (`POST /discover`) requires the caller to formulate a query every turn. Session continuity keeps previously-used tools alive but doesn't find new ones as the conversation evolves. Recall combines both: sticky previous tools + automatic new discovery — no manual query needed.

## How Recall Works

1. **Load previous session tools** — tools recalled in the last turn are loaded with score `1.0` (always included)
2. **Extract query** — the content of the last user message becomes the embedding query
3. **Discover new tools** — hybrid ranking (semantic + BM25) finds relevant tools, excluding those already loaded from the previous session
4. **Filter** — if `min_similarity` is set, newly discovered tools below that threshold are dropped
5. **Merge and persist** — previous + new tools are merged and saved for the next turn

If no user message exists (e.g., system-only conversation), only previous session tools are returned — no new discovery runs.

## Recall vs Discovery vs Session Continuity

| | Discovery | Session Continuity | Recall |
|---|---|---|---|
| Query source | Caller provides | N/A | Last user message (automatic) |
| Sticky tools | No | Yes (via turn capture) | Yes (built-in) |
| Finds new tools | Yes | No | Yes |
| Requires turn capture | No | Yes | No |
| Endpoint | `POST /discover` | `POST /turns` | `POST /context` |

Recall is the recommended approach for multi-turn agents. Discovery and session continuity are lower-level primitives for custom flows.

## API Usage

### Minimal request

```json
POST /api/v1/context

{
  "dataset": "my-agent",
  "namespace": "default",
  "session": "chat-123",
  "messages": {
    "strategy": "recent",
    "max_tokens": 4000
  },
  "recall": {
    "tools": true
  }
}
```

`"tools": true` uses defaults: limit 5, no minimum similarity.

### Configured request

```json
{
  "dataset": "my-agent",
  "namespace": "default",
  "session": "chat-123",
  "messages": {
    "strategy": "compacted",
    "max_tokens": 4000
  },
  "recall": {
    "tools": {
      "limit": 10,
      "min_similarity": 0.7
    }
  },
  "limit_tokens": 8000
}
```

### Response

```json
{
  "messages": [
    { "role": "user", "content": "What's the weather in Paris?" }
  ],
  "recalled": {
    "tools": [
      {
        "name": "get_weather",
        "description": "Get current weather for a city",
        "parameters": { "type": "object", "properties": { "city": { "type": "string" } } },
        "score": 0.94,
        "graph_expanded": false
      }
    ],
    "memories": []
  },
  "strategy_used": "recent",
  "token_estimate": 450,
  "total_messages": 12,
  "included_messages": 5,
  "conversation_messages": 5,
  "fallback": false
}
```

`recalled.memories` is reserved for future use (always empty today).

## Configuration Parameters

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `recall.tools` | `boolean \| object` | — (omit to skip) | Enable tool recall. `true` = use defaults |
| `recall.tools.limit` | `number` | `5` | Max tools to return (previous + new combined) |
| `recall.tools.min_similarity` | `number` | none | Minimum score for newly discovered tools. Previous session tools (score 1.0) are never filtered |

Omitting `recall` entirely from the request skips recall — the `recalled` field will contain empty arrays.

## Token Budgeting Interaction

When `limit_tokens` is set, recalled tools consume part of the total budget:

```
tool_token_cost = sum( (name.len + description.len + parameters_json.len) / 4 )
message_budget  = min(limit_tokens - tool_token_cost, messages.max_tokens)
```

**Example:** `limit_tokens=8000`, recalled tools cost 2000 tokens, `max_tokens=4000` → effective message budget = `min(8000-2000, 4000) = 4000`.

If tools consume most of the budget, the message budget shrinks accordingly. Without `limit_tokens`, messages and tools are budgeted independently.

## Session Stickiness

Recalled tool names are persisted per `(dataset, namespace, session)` triple:

- **Next turn:** those tools load at score `1.0` before any new discovery runs
- **Accumulation:** the tool set grows across turns as the conversation touches new topics
- **New sessions:** start with an empty tool set — no carryover between sessions
- **No user message:** if the latest messages contain no user message, previous tools are returned as-is (no new discovery)

This ensures tool availability is stable across turns while still adapting to new user intents.

## See Also

- [Chat Management](./chat-management.md) — Message strategies, summarization, token budgets
- [Session Continuity](./session-continuity.md) — Manual turn-based tool boosting
- [Hybrid Ranking](./ranking.md) — How new tool scores are computed
- [REST API](./api.md) — Endpoint reference
- [Tool Recall (TypeScript)](../typescript/tool-recall.md) — SDK usage guide
