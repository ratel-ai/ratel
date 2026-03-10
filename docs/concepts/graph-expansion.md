# Graph Expansion

Agentified can automatically inject dependency tools that weren't directly matched by the query but are required by tools that were.

## The Problem

Your agent discovers `update_employee_salary` — but that tool needs an `employee_id` from `get_employee`. Without graph expansion, the agent might not have `get_employee` in its tool set, causing a dead end.

## How It Works

### 1. Define dependencies via metadata

When registering tools, use `requires` and `provides` arrays in metadata:

```typescript
const tools = [
  tool({
    name: "get_employee",
    description: "Get employee by ID",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    metadata: { provides: ["employee_id", "employee_data"] },
  }),
  tool({
    name: "update_employee_salary",
    description: "Update an employee's salary",
    parameters: { type: "object", properties: { employee_id: { type: "string" }, salary: { type: "number" } }, required: ["employee_id", "salary"] },
    metadata: { requires: ["employee_id"] },
  }),
];
```

### 2. Automatic injection

After hybrid ranking selects the top-K tools, the server:

1. Collects all `requires` values from ranked tools
2. Scans all tools for ones with matching `provides` values
3. Ranks providers by coverage (how many required params they satisfy)
4. Injects up to `ceil(limit × 0.6)` provider tools

Injected tools have `graph_expanded: true` and `score: 0.0` in the response.

### 3. Response

```json
{
  "tools": [
    { "name": "update_employee_salary", "score": 0.91, "graph_expanded": false },
    { "name": "get_employee", "score": 0.0, "graph_expanded": true }
  ]
}
```

## Example

Query: `"update salary to 95000"`

| Tool | Ranked? | provides | requires |
|------|---------|----------|----------|
| `update_employee_salary` | Yes (0.91) | — | `employee_id` |
| `get_employee` | No (0.42) | `employee_id`, `employee_data` | — |
| `send_email` | No (0.15) | — | — |

`get_employee` wasn't in the top-K, but it provides `employee_id` which `update_employee_salary` requires. It gets injected with `graph_expanded: true`.

## Limits

- Max injected tools: `ceil(limit × 0.6)` — e.g., for `limit=5`, up to 3 extra tools
- Providers are sorted by coverage (tools satisfying more requirements come first)
- Already-ranked tools are never duplicated

## See Also

- [Architecture](../architecture.md) — Where graph expansion fits in the discovery flow
- [Hybrid Ranking](./ranking.md) — How base scores are computed
