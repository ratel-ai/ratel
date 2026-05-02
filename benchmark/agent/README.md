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
    llm.ts            Sonnet-as-judge primary for mode (c) (prompt-only fallback when no criteria)
  metering.ts         tokens, calls, turns, cost wrapped around agent.generate
  pool.ts             builds the per-scenario tool pool (gold + seeded distractors)
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

Ingests both corpora (if missing), runs retrieval modes (a) + (b), runs the mode-(c) agent campaign with conservative defaults if a provider key is set (skipped with a notice otherwise — keeping `run-all` $0 by default), and renders REPORT.md. See [`benchmark/README.md`](../README.md) for the full description.

Flags: `--force` (re-ingest), `--skip-ingest`, `--skip-agent` (skip mode (c) even with keys), `--only metatool|toolret`.

The auto-invoked mode (c) defaults to: 50 sampled scenarios × 1 run × all three arms, available models only (`claude-sonnet-4-6` and/or `gpt-5.4-mini` depending on which key is set), pool size 180, $5 global cap. For the headline variance run see the next section.

## Run the headline agent campaign (mode c)

```bash
# Required env (one or both):
#   OPENAI_API_KEY     — for gpt-5.4-mini
#   ANTHROPIC_API_KEY  — for claude-sonnet-4-6 (also powers the LLM judge)
#
# The default --corpus path expects the ingested MetaTool snapshot at
# benchmark/test-data/metatool.jsonl. Run `pnpm -F @ratel-ai/benchmark run-all`
# (or `cargo run -p ratel-benchmark-retrieval --release -- ingest metatool --download`)
# first.

pnpm -F @ratel-ai/benchmark start \
  --output benchmark/agent/results/agent.jsonl \
  --scenarios 200 \
  --arms control,hybrid,oracle \
  --models gpt-5.4-mini,claude-sonnet-4-6 \
  --runs 5 \
  --top-k 5 \
  --pool-size 180 \
  --max-steps 12 \
  --dollar-global 25 \
  --concurrency 10
```

Resumable — re-runs skip cells already in `agent.jsonl` unless `--force`. Pass `--ephemeral` instead to write each smoke into a fresh `benchmark/agent/results/ephemeral/agent-<timestamp>.jsonl` file so the canonical `agent.jsonl` stays untouched. `--scenarios N` samples a deterministic seeded subset of the full ~21k MetaTool query set; the same `--seed` reproduces the same subset across runs.

`--concurrency N` (default 10) controls how many cells run in parallel. The benchmark is wall-clock-bound on provider latency, so 10 typically yields ~10× speedup against cloud APIs. Dial down to `1` for Ollama (single-process server) or tight provider tiers. Dollar caps are best-effort under concurrency: in-flight cells finish, no new ones start, so overshoot is bounded by `concurrency × per-cell-cost` (~$0.30 at the defaults).

`--timeout-ms N` (default 60000) sets the per-cell wall-clock timeout. Cloud models rarely need more, but local Ollama models (especially CPU-bound or large 70B+) can comfortably exceed a minute on a 12-step trace — bump to `300000` (5 min) or higher when you see `run timed out after 60000ms` errors in the trace.

`--pool-size` controls the per-scenario tool catalog (gold + distractors pulled from other scenarios). The default (180) sits at the MetaTool plugin universe ceiling; smaller values stress retrieval less, larger values are clamped at the universe size.

For a fast local smoke (~$0.20–$1):

```bash
pnpm -F @ratel-ai/benchmark start \
  --scenarios 50 --runs 1 \
  --arms control,hybrid,oracle \
  --models claude-sonnet-4-6 \
  --pool-size 180 \
  --dollar-global 5 \
  --concurrency 10
```

## Local models (Ollama)

The `ollama:` model prefix routes through a local [Ollama](https://ollama.com) server's OpenAI-compatible endpoint — no API keys, $0 cost. Tool calling depends on the model's native function-calling support: Qwen / Llama families work well, Gemma is hit-or-miss.

```bash
# Make sure Ollama is running and the model is pulled (`ollama pull qwen3.5`).

pnpm -F @ratel-ai/benchmark start \
  --scenarios 50 --runs 1 \
  --arms control,hybrid \
  --models ollama:qwen3.5,ollama:gemma4 \
  --pool-size 180 \
  --judge-model ollama:qwen3.5 \  # cost-free local judge
  --concurrency 1 \               # local Ollama is single-process
  --timeout-ms 300000             # 5 min — local models often need more than 60s
```

Flags:
- `--ollama-base-url URL` — override the default `http://localhost:11434/v1` (or set `OLLAMA_BASE_URL` in the env). Useful for remote Ollama instances.
- `--judge-model MODEL` — pick any model id (cloud or `ollama:*`) for the LLM judge. Defaults to `claude-sonnet-4-6` when `ANTHROPIC_API_KEY` is set, otherwise the LLM judge is disabled and only the programmatic verdict is recorded.

`dollar_cost` is recorded as `0` for `ollama:*` cells — `--dollar-global` and `--dollar-cell` therefore never trip on local-only runs. If you mix cloud + local models in one run, the caps still bound the cloud spend. The model id keeps its `ollama:` prefix in the JSONL row and the report so local vs cloud cells stay distinguishable.

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

Unit tests cover the corpus reader, arm builders, metering math, both judges (programmatic intersection + LLM prompt-only fallback), pool universe + distractor expansion, runner orchestration (resume / dollar caps / cell iteration / seeded sampling), and report aggregations. Real LLM calls are not exercised in unit tests.
