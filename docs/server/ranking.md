# Ranking

Agentified offers three ranking strategies for tool discovery. **BM25 is the default** — it requires no embedding call per query, runs in sub-milliseconds, and works well whenever tool metadata shares vocabulary with the query. `semantic` and `hybrid` are opt-in via the `strategy` field on `discover`.

## Strategies

| Strategy | How it scores | When to use |
|----------|---------------|-------------|
| `bm25` *(default)* | Keyword matching with field-aware extraction from JSON Schema | Fast, cheap; works when the query shares terms with tool metadata |
| `semantic` | Weighted cosine similarity across 4 embedded fields | Intent-heavy queries where wording diverges from tool metadata |
| `hybrid` | `0.7 × semantic + 0.3 × normalized_bm25` | Both exact-match and intent-matching matter; worth the embedding cost |

If `semantic` or `hybrid` is requested and a tool has no embeddings available, the request falls back to `bm25` automatically.

## BM25

Standard [BM25](https://en.wikipedia.org/wiki/Okapi_BM25) with tuned parameters:

- `k1 = 0.9` — term frequency saturation
- `b = 0.4` — document length normalization

Each tool's BM25 document is built by concatenating its name, description, input-schema field names, and output-schema field names. Field names are extracted from JSON Schema `properties` so parameter keys contribute as first-class terms (e.g. `city`, `employee_id`) rather than getting lost inside raw JSON.

Raw BM25 scores are min-max normalized to `[0, 1]` across the tools in the dataset.

## Semantic

Each tool is embedded across 4 fields using OpenAI `text-embedding-3-small` (1536 dimensions). The query is embedded the same way, then cosine similarity is computed per field:

| Field | Default Weight | Why |
|-------|---------------|-----|
| `description` | 0.5 | Primary signal — describes what the tool does |
| `input_schema` | 0.3 | Matches parameter structure |
| `name` | 0.1 | Short, often abbreviated |
| `output_schema` | 0.1 | Return type — useful for chaining |

```
semantic = Σ(weight_i × cosine(query_emb, field_emb_i)) / Σ(active_weight_i)
```

Only fields with embeddings contribute. If a tool has no `output_schema`, its weight is excluded from the denominator.

### Customizing Weights

Pass `embedding_weights` on any discover request:

```json
{
  "query": "get employee salary details",
  "strategy": "semantic",
  "embedding_weights": {
    "name": 0.05,
    "description": 0.4,
    "input_schema": 0.4,
    "output_schema": 0.15
  }
}
```

Use case: bump `input_schema` weight when the query describes parameters rather than intent.

## Hybrid

```
final_score = 0.7 × semantic_score + 0.3 × normalized_bm25
```

BM25 acts as a tiebreaker and safety net:

- Two tools with similar embeddings → BM25 picks the one with exact keyword matches
- A tool with a generic description but exact parameter names → BM25 boosts it

## Worked Example

Given 3 tools and the query `"process a refund"` with `strategy: "hybrid"`:

| Tool | Semantic | BM25 (normalized) | Final |
|------|----------|-------------------|-------|
| `process_refund` | 0.89 | 0.95 | 0.7 × 0.89 + 0.3 × 0.95 = **0.908** |
| `get_order_details` | 0.72 | 0.30 | 0.7 × 0.72 + 0.3 × 0.30 = **0.594** |
| `send_email` | 0.35 | 0.00 | 0.7 × 0.35 + 0.3 × 0.00 = **0.245** |

`process_refund` ranks first — both signals agree. `get_order_details` ranks second — semantically related with some keyword overlap.

## See Also

- [Architecture](./architecture.md) — Full system design
- [Session Continuity](./session-continuity.md) — How previous turns affect scoring
- [Graph Expansion](./graph-expansion.md) — Dependency-based tool injection
