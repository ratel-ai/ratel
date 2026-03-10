# Session Continuity

Agentified tracks which tools were used in previous turns and ensures they remain available in subsequent queries. This prevents the LLM from losing context mid-conversation.

## The Problem

Without session continuity, each discover call is stateless. Turn 1 loads `get_employee` and `update_employee`. Turn 2's query might not match those tools — the LLM suddenly can't reference the employee it was just editing.

## How It Works

### 1. Capture a turn

After the LLM responds, capture which tools were loaded:

**TypeScript:**

```typescript
const { turnId } = await agent.captureTurn({
  toolsLoaded: ["get_employee", "update_employee"],
  message: "Show me Jane's record",
});
```

**Python:**

```python
result = await agent.capture_turn(
    tools_loaded=["get_employee", "update_employee"],
    message="Show me Jane's record",
)
turn_id = result.turn_id
```

**API:**

```
POST /api/v1/turns
{ "tools_loaded": ["get_employee", "update_employee"], "message": "Show me Jane's record" }
→ { "turn_id": "550e8400-..." }
```

### 2. Pass turn_id to discover

On the next turn, pass `turn_id` so the server remembers context:

**TypeScript:**

```typescript
const ranked = await agent.prefetch({
  messages: [{ role: "user", content: "Update her salary to 95000" }],
  turnId: turnId,
});
```

**Python:**

```python
ranked = await agent.prefetch(
    messages=[{"role": "user", "content": "Update her salary to 95000"}],
    turn_id=turn_id,
)
```

### 3. What happens server-side

1. Load the turn's `tools_loaded` list
2. Prepend those tools with `score=1.0` — they're always included
3. Exclude them from the ranked results (no duplicates)
4. Run normal hybrid ranking for remaining tools
5. Return: `[base tools (score=1.0)] + [newly ranked tools]`

## Multi-Turn Pattern

```
Turn 1:
  User: "Show me Jane's record"
  Discover → [get_employee (0.91), search_employees (0.78), ...]
  Agent uses get_employee
  Capture turn → turnId: "abc"

Turn 2:
  User: "Update her salary to 95000"
  Discover (turn_id: "abc") →
    [get_employee (1.0)]  ← base tool, always present
    + [update_employee (0.88), ...]  ← freshly ranked
  Agent uses update_employee

Turn 3:
  User: "Now show me the payroll summary"
  Discover (turn_id: "def") →
    [get_employee (1.0), update_employee (1.0)]  ← both from turn 2
    + [get_payroll (0.85), ...]  ← freshly ranked
```

## Why score=1.0?

Base tools get the maximum score so they always appear first. The LLM has context about these tools from previous turns — removing them mid-conversation breaks coherence.

## Storage

Turns are stored in-memory (default) or SQLite (with `AGENTIFIED_STORAGE=sqlite`). Each turn stores:

- `turn_id` — UUID, generated server-side
- `tools_loaded` — list of tool names used
- `message` — the user's message for that turn

## See Also

- [Architecture](../architecture.md) — Full discovery flow
- [Hybrid Ranking](./ranking.md) — How freshly ranked tools are scored
- [Storage](./storage.md) — Persistence configuration
