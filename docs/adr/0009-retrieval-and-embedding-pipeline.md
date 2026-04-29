# 9. Tool selection — retrieval method, embedding model, and reranker

Date: 2026-04-29

## Status

Proposed (locked default; spike scaffold landed in `scratch/spikes/retrieval-eval/`; promote to **Accepted** when the spike is run on a real corpus and numbers replace the default-position rationale below)

## Context

The two-stage tool-selection pipeline (retrieve → rerank) needs three concrete choices: stage-1 retrieval method, stage-1 embedding model, and stage-2 reranker. The architecture is locked (`docs/RATEL_V1_PLAN.md` §6 #6); only the algorithms remain open.

Locked going in (per RATEL_V1_PLAN.md §4.4 + §5):

- Local-only embeddings via `fastembed-rs`. No external override exposed in v1; internal `Embedder` trait as the seam.
- The spike picks the *model* from the v1 shortlist, not the embedder family.
- OpenAI is included in the spike as a quality reference *only*. Not a v1 shipping option.
- Storage stack from ADR 0003: SQLite + FTS5 + sqlite-vector (with sqlite-vec as fallback).

Phase 0 verification adjusted the model shortlist to fastembed-rs reality (see ADR 0003): "GTE-small" → `gte-base-en-v1.5`, "jina-small" → `jina-embeddings-v2-base-en`.

## Decision

**Default position (pending spike data):**

- **Stage 1 retrieval: hybrid** — SQLite FTS5 + sqlite-vector fused via Reciprocal Rank Fusion (RRF, k=60). FTS5 wins keyword queries; vector wins semantic queries; RRF gives the best of both with no tuning.
- **Embedding model: `BGE-small-en-v1.5`** — fastembed-rs's default; retrieval-specialized; good size/quality balance; small enough for the per-query CPU latency budget. The four-model spike shortlist is BGE-small-en-v1.5, all-MiniLM-L6-v2, Alibaba-NLP/gte-base-en-v1.5, jinaai/jina-embeddings-v2-base-en.
- **Stage 2 reranker: small-LLM (Haiku-class)** — re-ranks top-10 from stage 1 using a short prompt that includes the user query, candidate tools, and (per below) the telemetry "preferences" signal. Cohere Rerank and BGE-reranker are evaluated as alternatives in the spike's borderline-query check; the choice can revisit in Phase 6.
- **Telemetry entry points** — locked at architectural level, parameter-tuned in Phase 6:
  - **Stage 1 score boost** — recency-weighted pick rate per (user/team, query similarity, tool) gets added to the BM25/vector score before RRF. Cheap to compute; wide impact on ranking.
  - **Stage 2 reranker prompt input** — a "preferences" line in the reranker prompt summarizes which tools this user/team has historically picked vs. abandoned for similar queries. Lets the LLM reranker apply soft, contextual weighting.

**The spike** runs the (3 retrieval methods × 4 embedding models) matrix on a real corpus + labeled query set, measures recall@5/recall@10 and per-query CPU latency per cell, sanity-checks rerankers on borderline queries, and either confirms or refutes each component of the default. See `scratch/spikes/retrieval-eval/` for the runnable harness and `RATEL_PHASE_0.md` §6.6 for the full spike protocol.

**Contingency triggers** — the ADR is updated, not just promoted, if:

1. Hybrid does not beat the best single method by >~3 points recall@10 → drop one of FTS5/sqlite-vector to reduce surface area (RATEL_V1_PLAN.md §5 contingency).
2. The chosen model's per-query CPU latency blows the budget compatible with the <50ms cold-start NFR (§4.4) → pick the next-fastest model from the shortlist within ~3 points recall (e.g., `intfloat/multilingual-e5-small`, `snowflake/snowflake-arctic-embed-xs`).
3. OpenAI text-embedding-3-small materially outperforms the best local model (e.g., >7 points recall@10) → the gap becomes input to a v1.1 conversation about cloud-embedder strategy. v1 stays local regardless (RATEL_V1_PLAN.md §4.4).

## Consequences

- **Phase 1's tool-selection module and Embedder module both depend on this ADR being Accepted with measured numbers, not default-position handwave.** Per `RATEL_PHASE_0.md` §6.6 and §8: do not start Phase 1 with this ADR still Proposed.
- The spike harness in `scratch/spikes/retrieval-eval/` is **runnable** (passes `cargo check`) but ships with a 12-tool / 10-query seed corpus that's only large enough to validate the harness itself. The acceptance gate requires running it against a real 50–100-tool / 30–50-query labeled set.
- The spike intentionally uses in-memory cosine similarity for the vector cell, not sqlite-vector ANN — fine for ≤100-tool corpora and avoids requiring the prebuilt sqlite-vector binary at spike time. Verifying that sqlite-vector + rusqlite's `load_extension` works end-to-end happens as a separate small Rust test in `core/lib` once Phase 1 starts (per ADR 0003's verification overlap).
- If the spike confirms the default position, the only narrative-time cost is "we ran the experiment and it confirmed." If it refutes any component, the ADR's contingency triggers above name the alternative path explicitly so the next decision is mechanical, not a re-deliberation.
- The "no external embedder override in v1" stance (RATEL_V1_PLAN.md §4.4, ADR 0003) means the spike's OpenAI quality-reference cell does not become a shipping path even if it wins. That's by design.
- Reranker choice is deliberately **lighter-locked** — a tradeoff document in this ADR is acceptable, since Phase 6 revisits the reranker as part of telemetry-weighting tuning. Stage-1 retrieval and embedding model, by contrast, ship in Phase 1 and are harder to change later.
