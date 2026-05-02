# `benchmark/agent/`

End-to-end agent layer of the benchmark plus the unified suite orchestrator. Drives the Vercel AI SDK [`ToolLoopAgent`](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) under three arms (control / hybrid / oracle), meters token usage, judges correctness, and emits one JSONL row per `(scenario, arm, model, run)` cell. Mode (c) per ADR-0006 is the agent campaign this layer powers.

Pairs with the Rust retrieval-only layer at [`benchmark/retrieval/`](../retrieval). For modes overview see [`benchmark/README.md`](../README.md). Locked decisions in [`docs/adr/0005-benchmark-design.md`](../../docs/adr/0005-benchmark-design.md), [`0006`](../../docs/adr/0006-benchmark-corpus-and-eval-modes.md), [`0007`](../../docs/adr/0007-benchmark-corpus-not-snapshotted.md).

## Layout

```
src/
  arms.ts             control / hybrid / oracle tool-set builders
  cli.ts              entry — pnpm start (mode c agent campaign)
  corpus.ts           reads the shared JSONL scenario format
  judges/
    programmatic.ts   selection-intersection (per ADR-0006)
    llm.ts            Sonnet-as-judge primary for mode (c)
  metering.ts         tokens, calls, turns, cost wrapped around agent.generate
  report.ts           aggregator (medians, savings, retrieval, taxonomy)
  report-cli.ts       entry — pnpm report
  run-all.ts          entry — pnpm run-all (whole benchmark: ingest + a + b + c + report)
  runner.ts           orchestrates cells, resumable, dollar-capped
  types.ts            CellResult + Scenario shapes shared across modules
```

## Run the whole benchmark

```bash
pnpm -F @ratel-ai/benchmark run-all
```

Ingests both corpora (if missing), runs retrieval modes (a) + (b), skips mode (c) until it ships, and renders REPORT.md. See [`benchmark/README.md`](../README.md) for the full description.

Flags: `--force` (re-ingest), `--skip-ingest`, `--only metatool|toolret`.

## Run an agent campaign (mode c — coming soon)

```bash
# Required env (one or both):
#   OPENAI_API_KEY     — for gpt-5.4-mini
#   ANTHROPIC_API_KEY  — for claude-sonnet-4-6 (also powers the LLM judge)
#
# The default --corpus path expects the ingested MetaTool snapshot at
# benchmark/test-data/metatool.jsonl. Run `pnpm -F @ratel-ai/benchmark run-all`
# (or `cargo run -p ratel-benchmark-retrieval --release -- ingest metatool --download`)
# first. Defaults run all three arms × both models × 1 run; use --runs 5 for the
# full v0.1.1 variance protocol.

pnpm -F @ratel-ai/benchmark start \
  --output benchmark/agent/results/agent.jsonl \
  --arms control,hybrid,oracle \
  --models gpt-5.4-mini,claude-sonnet-4-6 \
  --runs 5 \
  --top-k 5 \
  --max-steps 12 \
  --dollar-global 25
```

Resumable — re-runs skip cells already in `agent.jsonl` unless `--force`.

The mode-(c) wiring in `start` is currently the v0.1.1-harness scaffolding; until the mode-(c) slice in the plan lands, prefer `run-all` for end-to-end runs (it skips this step with a notice).

## Generate the report only

```bash
pnpm -F @ratel-ai/benchmark report \
  --agent benchmark/agent/results/agent.jsonl \
  --retrieval benchmark/results/retrieval.jsonl \
  --output benchmark/results/REPORT.md
```

Auto-discovers every `*retrieval.jsonl` under `benchmark/results/` if `--retrieval` is omitted.

## Tests

```bash
pnpm -F @ratel-ai/benchmark test
```

Unit tests cover the corpus reader, arm builders, metering math, both judges (programmatic and LLM-error paths), runner orchestration (resume / dollar caps / cell iteration), and report aggregations. Real LLM calls are not exercised in unit tests.
