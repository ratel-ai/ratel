# 4. BM25 tool indexing — what to index, and how

Date: 2026-04-30

## Status

Accepted

## Context

`ratel-core` ranks an agent's registered tools per query and returns the top‑K. The v0.1.x demo target is "fewer input tokens once Ratel is added" (see ADR‑0003), so retrieval quality at this layer directly drives the headline benchmark.

Each registered tool carries a name, a free‑text description, and JSON Schema for its input and output parameters. Two questions stack up: which BM25 implementation do we use, and what string do we feed it per tool? Indexing the raw schema JSON would pollute the corpus with structural tokens (`type`, `properties`, braces, quotes) that the user never queries for and that BM25 would treat as ordinary terms — degrading IDF for the tokens that actually carry meaning.

## Decision

- Use the [`bm25`](https://crates.io/crates/bm25) crate (v2.3.x) with its default English tokenizer for scoring. Rolling our own offers no leverage at this stage; the crate is small, well‑scoped, and lets us focus our work on what to index rather than how BM25 is computed.
- Tune BM25 with `k1 = 0.9`, `b = 0.4` (the crate's defaults are `k1 = 1.2`, `b = 0.75`). Tool descriptions are short, so we want term frequency to saturate faster (lower `k1`) and to apply less length normalization (lower `b`). These values were validated on the previous iteration of this codebase.
- `Tool` carries `input_schema` and `output_schema` as `serde_json::Value`. Both are indexed.
- A private `searchable_text(&Tool) -> String` flattener walks each schema and emits **only semantic tokens** in this order:
  1. `tool.name`
  2. `tool.description`
  3. for each property in `properties`, in **schema‑defined order**:
     - the property key
     - its `description` if present
     - each string value of `enum` if present
     - recursive flatten on the property (handles nested objects and array `items`)
  4. same for `output_schema`
- Schema‑defined property order is preserved via `serde_json`'s `preserve_order` feature, so the indexed string is deterministic and stable as long as the input schema is.
- The flattener **skips** `type`, `required`, `$ref`, `$schema`, `additionalProperties`, and JSON syntax (braces, quotes). These are structure, not semantics.

## Consequences

- The tool author's vocabulary — the tokens they put in `description`, parameter names, parameter descriptions, enum values — flows directly into recall. Quality of tool documentation becomes the lever for retrieval quality, which is a feature: it gives the integrator a clear knob without exposing scoring internals.
- Both schemas are indexed even though most tools today carry richer input schemas than output schemas. We accept the asymmetry for a uniform API.
- The flattened representation is the contract that downstream features (telemetry, suggestions, the future semantic‑search milestone) build on. Changing the flattening algorithm is a breaking change for those features and would warrant a superseding ADR.
- Rolling our own BM25 is rejected: it adds maintenance for no quality or performance gain at this scope.
- Embedding raw JSON strings is rejected: structural tokens flatten the term distribution, hurt IDF, and bloat the corpus without recall benefit.
- A typed Rust schema struct (instead of `serde_json::Value`) is rejected: it locks the public `Tool` shape and forces conversions at every framework boundary (MCP, OpenAI, etc.). `Value` lets the flattener evolve without changing the public type.
- The `bm25` crate's English tokenizer is the project default for now. A future ADR can revisit per‑language tokenization once the benchmark or a non‑English integration demands it.
- The `k1` / `b` choice is locked here so the benchmark can be reproduced. If profiling or quality analysis later argues for different values (or for exposing them as a public knob), a superseding ADR records the change.
