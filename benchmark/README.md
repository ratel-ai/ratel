# `benchmark/`

Two-layer harness measuring Ratel's retrieval quality and (eventually) agent-loop token savings. Backs every "Ratel does X better" claim. New product features that touch retrieval or context shape are expected to add a corresponding scenario before being declared done.

Locked decisions live in:

- [`docs/adr/0005-benchmark-design.md`](../docs/adr/0005-benchmark-design.md) — overall harness (arms, models, variance, results storage)
- [`docs/adr/0006-benchmark-corpus-and-eval-modes.md`](../docs/adr/0006-benchmark-corpus-and-eval-modes.md) — corpus pivot + the three eval modes
- [`docs/adr/0007-benchmark-corpus-not-snapshotted.md`](../docs/adr/0007-benchmark-corpus-not-snapshotted.md) — corpus is ingested locally; no committed snapshot, no MetaTool sampling

## Layout

```
retrieval/    Rust crate (ratel-benchmark-retrieval) — ingest + BM25 metrics
agent/        TypeScript pnpm package (@ratel-ai/benchmark) — agent campaign + report
fixtures/     raw upstream downloads (gitignored)
test-data/    normalized JSONL produced by `ingest` (gitignored — ADR-0007)
results/      retrieval / agent JSONL outputs + REPORT.md (gitignored)
```

Both `retrieval/` and `agent/` have their own README with the details of how to run their layer.

## Eval modes

Per [ADR-0006](../docs/adr/0006-benchmark-corpus-and-eval-modes.md), three eval modes split across two suites.

**Retrieval-only** — fast, deterministic, $0, no API keys. Backs claims about ranking quality. Lives in [`retrieval/`](retrieval/).

- **(a) MetaTool — pre-fetch retrieval (replace path).** Measures whether BM25 surfaces the right tool given a real user-task query, before the agent's turn. 199 OpenAI plugin descriptions + ~21k user queries (MIT).
- **(b) ToolRet — IR / autonomous-discovery retrieval (gateway path).** Measures whether the index ranks correctly when the agent emits an IR-shaped query mid-loop (e.g. `searchTools("a tool that converts currency")`). 7,961 retrieval tasks across 35 sub-corpora over a 44,453-tool catalog (Apache-2.0).

**Agentic** — end-to-end agent runs with token cost + correctness signals. Requires API keys. Lives in [`agent/`](agent/).

- **(c) MetaTool tasks + LLM-as-judge.** Runs control (baseline + oracle) arms alongside three Ratel arms (full / pre-discovery only / discovery-tool only) on MetaTool user-task queries with stubbed tool responses. The full Ratel arm pre-discovers BM25 top-K from the prompt *and* exposes the gateway (`search_tools` / `invoke_tool`) so the model can recover when pre-discovery missed; the two ablations isolate which layer is doing the work. An optional local-only `claude-sdk-tool-search` arm can be wired up alongside as a competitive baseline against Anthropic's native tool-search-tool. Programmatic judge does selection-only intersection (`effective_tool_ids ∩ gold_tools ≠ ∅`); the LLM judge scores final-text coherence against the user prompt as a fallback / tiebreaker. Reports input/output tokens, cache hit rate, $-cost, and wall-clock time at realistic catalog sizes (default pool size 180), averaged per-scenario across runs and then across scenarios.

## Run the whole benchmark

```bash
pnpm -F @ratel-ai/benchmark run-all
```

This single command:

1. Ingests MetaTool and ToolRet (downloads upstream sources via `curl`) if their normalized JSONL isn't already present under `benchmark/test-data/`.
2. Runs BM25 retrieval over each corpus at corpus-appropriate pool sizes (modes a + b).
3. Runs the mode-(c) MetaTool agent campaign with conservative defaults if `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` is set; otherwise prints a notice and skips. Defaults: 50 sampled scenarios × 1 run × every committed arm × available models, $5 global cap.
4. Renders `benchmark/results/REPORT.md` from the retrieval and (if present) agent JSONL outputs.

Re-running `run-all` skips ingest when the snapshot already exists; pass `--force` to re-ingest, `--skip-ingest` to fail loudly if missing, `--skip-agent` to opt out of mode (c) even when keys are set, or `--only metatool|toolret` to restrict retrieval to one corpus. For the headline N=5 variance run, invoke `pnpm -F @ratel-ai/benchmark start` directly — see [`agent/README.md`](agent/README.md).

## Or run a single mode

For tighter loops on one suite, use the per-layer commands documented next to the code:

- Retrieval (modes a + b) — see [`retrieval/README.md`](retrieval/README.md).
- Agent campaign (mode c, when shipped) — see [`agent/README.md`](agent/README.md).

## Corpus format

All suites consume the same JSONL — one `Scenario` per line:

```jsonc
{
  "id": "fs-001",
  "prompt": "Show me /etc/hosts.",
  "candidate_pool": [ /* tools available in this scenario */ ],
  "gold_tools": ["fs.read_file"],
  "judge_criteria": "mentions localhost",
  "category": "filesystem"
}
```

The Rust definition in [`retrieval/src/corpus.rs`](retrieval/src/corpus.rs) is canonical. The TS mirror in [`agent/src/types.ts`](agent/src/types.ts) tracks it.
