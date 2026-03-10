# Hybrid Ranking

Agentified uses a hybrid ranking algorithm that combines semantic similarity with BM25 keyword matching to select the most relevant tools for a query.

## How It Works

```
final_score = 0.7 × semantic_score + 0.3 × normalized_bm25
```

Two signals, complementary strengths:

- **Semantic** (70%) — catches intent even with different wording ("cancel my subscription" → `process_refund`)
- **BM25** (30%) — catches exact keyword matches the embedding model might under-weight ("PTO" → `get_pto_balance`)

## Semantic Scoring

Each tool is embedded across 4 fields using OpenAI `text-embedding-3-small` (1536 dimensions). The query is embedded the same way, then cosine similarity is computed per field:

| Field | Default Weight | Why |
|-------|---------------|-----|
| `description` | 0.5 | Primary signal — describes what the tool does |
| `input_schema` | 0.3 | Matches parameter structure (e.g., "city" aligns with weather tools) |
| `name` | 0.1 | Tool name — short, often abbreviated |
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
  "embedding_weights": {
    "name": 0.05,
    "description": 0.4,
    "input_schema": 0.4,
    "output_schema": 0.15
  }
}
```

Use case: bump `input_schema` weight when the query describes parameters rather than intent.

## BM25 Scoring

Standard [BM25](https://en.wikipedia.org/wiki/Okapi_BM25) with parameters:

- `k1 = 1.2` — term frequency saturation
- `b = 0.75` — document length normalization

Each tool's BM25 document is the concatenation of all its field texts (name + description + input_schema + output_schema). The query is tokenized by splitting on non-alphanumeric characters and lowercasing.

### Normalization

Raw BM25 scores are min-max normalized to [0, 1] across all tools in the dataset:

```
normalized = (raw - min) / (max - min)
```

If all scores are equal (range = 0), all normalized scores are 0.

## Worked Example

Given 3 tools and the query `"process a refund"`:

| Tool | Semantic | BM25 (normalized) | Final |
|------|----------|-------------------|-------|
| `process_refund` | 0.89 | 0.95 | 0.7 × 0.89 + 0.3 × 0.95 = **0.908** |
| `get_order_details` | 0.72 | 0.30 | 0.7 × 0.72 + 0.3 × 0.30 = **0.594** |
| `send_email` | 0.35 | 0.00 | 0.7 × 0.35 + 0.3 × 0.00 = **0.245** |

`process_refund` ranks first — both signals agree. `get_order_details` ranks second — semantically related (orders context) with some keyword overlap.

## When Semantic and BM25 Disagree

The 70/30 split means semantic usually dominates. BM25 acts as a tiebreaker and safety net:

- Two tools with similar embeddings → BM25 picks the one with exact keyword matches
- A tool with a generic description but exact parameter names → BM25 boosts it

## See Also

- [Architecture](../architecture.md) — Full system design
- [Session Continuity](./session-continuity.md) — How previous turns affect scoring
- [Graph Expansion](./graph-expansion.md) — Dependency-based tool injection
