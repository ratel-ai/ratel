# `benchmark/agent/`

End-to-end agent layer of the benchmark. Drives the Vercel AI SDK [`ToolLoopAgent`](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) under three arms (control / hybrid / oracle), meters token usage, judges correctness, and emits one JSONL row per `(scenario, arm, model, run)` cell.

Pairs with the Rust retrieval-only layer at [`benchmark/`](../). See [`docs/adr/0005-benchmark-design.md`](../../docs/adr/0005-benchmark-design.md) for the design.

## Layout

```
src/
  arms.ts             control / hybrid / oracle tool-set builders
  cli.ts              entry — pnpm start
  corpus.ts           reads the shared JSONL scenario format
  judges/
    programmatic.ts   gold-trace match
    llm.ts            Sonnet-as-judge fallback
  metering.ts         tokens, calls, turns, cost wrapped around agent.generate
  report.ts           aggregator (medians, savings, retrieval, taxonomy)
  report-cli.ts       entry — pnpm report
  runner.ts           orchestrates cells, resumable, dollar-capped
  types.ts            CellResult + Scenario shapes shared across modules
```

## Running an agent campaign

```bash
# Required env (one or both):
#   OPENAI_API_KEY     — for gpt-5.4-mini
#   ANTHROPIC_API_KEY  — for claude-sonnet-4-6 (also powers the LLM judge)
#
# Defaults run all three arms × both models × 1 run on the synthetic fixture.
# Use --runs 5 for the full v0.1.1 variance protocol.

pnpm -F @ratel-ai/benchmark start \
  --corpus benchmark/test-data/synthetic.jsonl \
  --output benchmark/agent/results/agent.jsonl \
  --arms control,hybrid,oracle \
  --models gpt-5.4-mini,claude-sonnet-4-6 \
  --runs 5 \
  --top-k 5 \
  --max-steps 12 \
  --dollar-global 25
```

Resumable — re-runs skip cells already in `agent.jsonl` unless `--force`.

## Generating the report

```bash
pnpm -F @ratel-ai/benchmark report \
  --agent benchmark/agent/results/agent.jsonl \
  --retrieval benchmark/results/retrieval.jsonl \
  --output benchmark/results/REPORT.md
```

## Tests

```bash
pnpm -F @ratel-ai/benchmark test
```

Unit tests cover the corpus reader, arm builders, metering math, both judges (programmatic and LLM-error paths), runner orchestration (resume / dollar caps / cell iteration), and report aggregations. Real LLM calls are not exercised in unit tests.
