# 4. Kernel retrieval: BM25 indexing and replace-vs-suggest selection

Date: 2026-07-05

## Status

Accepted

Compacted 2026-07 from pre-compaction ADR-0003 (tool selection, 2026-04-30) and ADR-0004
(BM25 tool indexing, 2026-04-30).

## Context

The kernel ranks an agent's registered tools per query and returns the top-K. Two questions
stack: what string does BM25 see per tool (indexing raw schema JSON would drown the
meaningful tokens in structural noise), and how does the ranked result reach the model
(replace the tool list, or suggest alongside it).

## Decision

### Indexing

- Use the [`bm25`](https://crates.io/crates/bm25) crate with its default English tokenizer.
  Tuning: `k1 = 0.9`, `b = 0.4` (below the crate defaults): tool descriptions are short, so
  term frequency saturates faster and length normalization matters less.
- `Tool` carries `input_schema` and `output_schema` as `serde_json::Value`; both are indexed.
- A private `searchable_text(&Tool) -> String` flattener emits **only semantic tokens**, in
  order: tool name, description, then per property in schema-defined order its key,
  description, and enum string values, recursing into nested objects and array `items`; the
  same for the output schema. Structural tokens (`type`, `required`, `$ref`, braces, quotes)
  are skipped. Schema-defined order is preserved via `serde_json`'s `preserve_order`, so the
  indexed string is deterministic.
- The flattened projection is a contract: telemetry, suggestions, and future retrieval layers
  build on it. Changing the flattening algorithm is a breaking change and warrants
  supersession.

### Selection

- **`replace` is the default**: Ratel intercepts the tool list before the model call and
  replaces it with the ranked top-K. The token reduction is direct and attributable.
- **`suggest` is opt-in**: a ranked subset emitted alongside the existing tool list, for
  frameworks that own the list and offer no replace seam.
- Both modes are a configurable enum on the public API; each framework integration wires the
  chosen mode to the framework's actual tool-injection point.

## Consequences

- The tool author's vocabulary (description, parameter names, enum values) flows directly
  into recall: documentation quality is the retrieval lever, and the integrator's knob.
- The `k1`/`b` choice is locked so benchmark results reproduce; exposing them as a public
  knob would be a superseding change.
- Rejected: rolling our own BM25 (maintenance, no gain at this scope); indexing raw JSON
  (flattens term distribution, hurts IDF); a typed schema struct instead of `Value` (locks
  the public `Tool` shape at every framework boundary); `suggest` as default (ranking
  competes with framework-appended tools, savings become unattributable).
