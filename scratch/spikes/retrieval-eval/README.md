# Retrieval × embedding evaluation harness

> Throwaway research code for ADR 0009 (`docs/adr/0009-...`).
>
> NOT part of the main Cargo workspace; not built by CI.

## What it does

Loads a tool corpus and a labeled query set (both JSONL), runs a (retrieval method × embedding model) matrix, prints recall@5, recall@10, and average per-query latency.

Stage-1 retrieval methods evaluated:

- **BM25** via SQLite FTS5 (no embedding axis; one row).
- **Vector** — cosine similarity over fastembed-rs embeddings (one row per model).
- **Hybrid** — Reciprocal Rank Fusion of the two (one row per model).

The default model set is `bge-small,minilm-l6,gte-base,jina-base` — the four candidates settled on in ADR 0003 (closest fastembed-rs-supported variants of the v1 plan's shortlist).

## Format

**Corpus** — one tool per line in JSONL:

```json
{"id": "github.create_issue", "name": "create_issue", "description": "Create a new issue ..."}
```

**Queries** — one query per line, each with one or more ground-truth relevant tool IDs:

```json
{"text": "create a new github issue", "relevant_ids": ["github.create_issue"]}
```

The included `data/corpus.jsonl` and `data/queries.jsonl` are 12-tool / 10-query seeds — enough to validate the harness runs end-to-end. **Replace with a real 50–100-tool, 30–50-query labeled set before locking ADR 0009 numbers.** Per the Phase 0 plan §6 step 1: scrape from real MCP servers (GitHub, Linear, filesystem, Slack, Notion); supplement with synthetic descriptions if real ones are too sparse to discriminate.

## Run

```bash
# from this directory
cargo run --release -- \
  --corpus data/corpus.jsonl \
  --queries data/queries.jsonl \
  --models bge-small,minilm-l6,gte-base,jina-base
```

First run downloads each fastembed model's ONNX weights (~100MB per model). They're cached afterward.

## What this harness does NOT do

- **Reranker stage 2.** Per Phase 0 §6 step 6, run a separate sanity check on the top-10 from the best stage-1 cell against (a) a Haiku-class LLM and (b) Cohere Rerank or BGE-reranker. Use win rate on borderline queries (relevant tool placed at rank 3-10), not full recall.
- **OpenAI text-embedding-3-small as a quality reference.** Per Phase 0 §6 step 4, this is included as a quality reference only — *not* a shipping option. Add an OpenAI-API call cell here when you want to measure the gap between "shipping local" and "what cloud could do."
- **sqlite-vector vs sqlite-vec verification.** Per Phase 0 §6 step 7, the spike confirms the prebuilt sqlite-vector binary loads via rusqlite's `load_extension` on macOS / Linux / Windows. Do this as a separate small Rust test in `core/lib` once Phase 1 starts; it doesn't need to live in this harness (the harness uses in-memory cosine, not sqlite-vector ANN — fine for ≤100-tool corpora).

## What to capture in ADR 0009

When you run this with a real corpus + queries:

1. **Per-cell numbers** — recall@5, recall@10, avg ms/query for every (method × model) combination. Paste the table into ADR 0009.
2. **Borderline-query reranker results** — separate, smaller table.
3. **Verdict on the contingency triggers in Phase 0 §6 step 9:**
   - Did hybrid beat the best single method by >~3 points recall@10? If not, drop one of FTS5/sqlite-vector.
   - Did the chosen embedding model's per-query latency fit the per-query budget compatible with the <50ms cold-start NFR? If not, pick a smaller model.
4. Promote ADR 0009 from **Proposed** to **Accepted**.
