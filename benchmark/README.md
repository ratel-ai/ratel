# `benchmark/`

Two-layer harness measuring Ratel's retrieval quality and agent-loop token savings. Backs every "Ratel does X better" claim. New product features that touch retrieval or context shape are expected to add a corresponding scenario before being declared done.

See [`docs/adr/0005-benchmark-design.md`](../docs/adr/0005-benchmark-design.md) for the locked decisions (arms, corpus, oracle, models, variance, results storage).

## Layout

```
src/             Rust library + binary — corpus loader, retrieval-only metrics, runner CLI
agent/           TypeScript pnpm package — arm builders, agent runner, metering, judges, report
test-data/       small synthetic corpus (committed) — used by smoke runs and tests
fixtures/        cached corpora ingested from external sources (gitignored)
results/         outputs: retrieval.jsonl + REPORT.md (gitignored)
```

Crate name (Rust): `ratel-benchmark`. Workspace member (Cargo). \
Package name (TS): `@ratel-ai/benchmark`. Workspace member (pnpm). See [`agent/README.md`](agent/README.md).

## Running the retrieval-only layer

```bash
cargo run -p ratel-benchmark -- retrieval \
  --corpus benchmark/test-data/synthetic.jsonl \
  --output benchmark/results/retrieval.jsonl \
  --top-k 5 \
  --pool-sizes 30,150,600
```

Emits one JSONL row per `(scenario, pool_size)` cell with recall@K, MRR, hit@K. No LLM, no API keys — fast, deterministic.

## Running the agent layer

See [`agent/README.md`](agent/README.md). Requires API keys.

## Generating the merged report

After both layers have written their JSONL outputs:

```bash
pnpm -F @ratel-ai/benchmark report \
  --agent benchmark/agent/results/agent.jsonl \
  --retrieval benchmark/results/retrieval.jsonl \
  --output benchmark/results/REPORT.md
```

## Corpus format

Both layers consume the same JSONL — one `Scenario` per line:

```jsonc
{
  "id": "fs-001",
  "prompt": "Show me /etc/hosts.",
  "candidate_pool": [ /* tools available in this scenario */ ],
  "gold_tools": ["fs.read_file"],
  "gold_trace": [{ "tool_id": "fs.read_file", "args": {...}, "response": {...} }],
  "judge_criteria": "mentions localhost",
  "category": "filesystem"
}
```

The Rust definition in [`src/corpus.rs`](src/corpus.rs) is canonical. The TS mirror in [`agent/src/types.ts`](agent/src/types.ts) tracks it.

The synthetic fixture at `test-data/synthetic.jsonl` is the smoke-run input. To run against a public corpus (e.g. ToolBench), ingest it into the same format and place under `fixtures/` (gitignored).
