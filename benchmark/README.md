# `benchmark/`

Two-layer harness measuring Ratel's retrieval quality and agent-loop token savings. Backs every "Ratel does X better" claim. New product features that touch retrieval or context shape are expected to add a corresponding scenario before being declared done.

Locked decisions live in [`docs/adr/0005-benchmark-design.md`](../docs/adr/0005-benchmark-design.md) (overall harness — arms, models, variance, results storage) and [`docs/adr/0006-benchmark-corpus-and-eval-modes.md`](../docs/adr/0006-benchmark-corpus-and-eval-modes.md) (corpus pivot + the three eval modes the suites below map to).

## Layout

```
src/             Rust library + binary — corpus loader, retrieval-only metrics, runner CLI, ingestion adapters
agent/           TypeScript pnpm package — arm builders, agent runner, metering, judges, report
test-data/       committed corpora — synthetic smoke fixture and sampled snapshots from public sources (see test-data/SOURCES.md)
fixtures/        raw corpora downloaded from external sources (gitignored)
results/         outputs: retrieval.jsonl + REPORT.md (gitignored)
```

Crate name (Rust): `ratel-benchmark`. Workspace member (Cargo). \
Package name (TS): `@ratel-ai/benchmark`. Workspace member (pnpm). See [`agent/README.md`](agent/README.md).

## Benchmark suites

Per [ADR-0006](../docs/adr/0006-benchmark-corpus-and-eval-modes.md), three eval modes split across two suites:

**Retrieval-only** — fast, deterministic, $0, no API keys. Backs claims about ranking quality.

- ✅ **MetaTool — pre-fetch retrieval (replace path).** Measures whether BM25 surfaces the right tool given a real user-task query, before the agent's turn. Catalog of 199 OpenAI plugin descriptions, ~21k user queries (MIT). _ADR-0006 mode (a)._
- 🚧 **ToolRet — IR / autonomous-discovery retrieval (gateway path).** _Coming soon._ Measures whether our index ranks correctly when the agent emits an IR-shaped query mid-loop (e.g. `searchTools("a tool that converts currency")`). 7,600 retrieval tasks over a 43k-tool corpus, directly comparable to ToolRet's published leaderboard. _ADR-0006 mode (b)._

**Agentic** — end-to-end agent runs with token cost + correctness signals. Requires API keys.

- 🚧 **MetaTool tasks + LLM-as-judge.** _Coming soon._ Runs control + Ratel hybrid arms on MetaTool user-task queries with stubbed tool responses; LLM scores answer quality and selection coherence. Reports input/output tokens, cache hit rate, and $-cost at realistic catalog sizes. _ADR-0006 mode (c)._

The current canonical workflow runs the MetaTool retrieval-only suite (mode a). The two `coming soon` modes follow the same harness contract; the corpus format below is shared across all three.

## Quickstart: MetaTool retrieval-only (mode a)

Two commands. Step 1 ingests MetaTool into the harness's normalized JSONL; step 2 runs BM25 retrieval over it.

### 1. Ingest MetaTool

```bash
cargo run -p ratel-benchmark --release -- ingest metatool --download
```

`--download` pulls the three upstream MetaTool sources via `curl` into `benchmark/fixtures/metatool/` (gitignored), then samples 1000 rows (≈970 single-tool + ≈30 multi-tool, seed 42) and writes `benchmark/test-data/metatool.jsonl`. Defaults reproduce the committed snapshot byte-for-byte.

Tunables (`... ingest metatool --help` for the full list):

- `--download` — pull upstream sources via `curl` before ingesting. Drop the flag to re-ingest pre-existing files.
- `--sample N` (default `1000`) — total scenarios written (single + multi combined). Caps the snapshot size; upstream has ~21k queries.
- `--multi-tool-ratio R` (default `0.03`) — fraction of `--sample` reserved for multi-tool scenarios. Mirrors upstream's ~497/20630 ≈ 0.024 proportion. Best-effort: if fewer multi-tool rows exist, the remainder fills from single-tool.
- `--seed N` (default `42`) — seed for the deterministic sampler. Same seed + same upstream files → byte-identical output.
- `--fixtures-dir PATH` (default `benchmark/fixtures/metatool`) — where downloaded files live (and are read from when `--download` is omitted).
- `--plugins / --single-tool / --multi-tool` — override individual source paths if your layout doesn't match upstream's.

### 2. Run retrieval

```bash
cargo run -p ratel-benchmark --release -- retrieval \
  --corpus benchmark/test-data/metatool.jsonl \
  --output benchmark/results/metatool-retrieval.jsonl \
  --top-k 1,3,5,10 --pool-sizes 30,100,180
```

Emits one JSONL row per `(scenario, pool_size, k)` cell with recall@K, precision@K, MRR@K, hit@K. One BM25 ranking per query is sliced at every K cutoff, so adding more K values is essentially free.

Tunables:

- `--corpus PATH` — JSONL corpus to evaluate. Above we point at the file produced by step 1.
- `--output PATH` (default `benchmark/results/retrieval.jsonl`) — where to write the metrics JSONL. Gitignored.
- `--top-k A,B,C` (default `1,3,5,10`) — comma-separated K cutoffs. The report renders one row per K so the degradation curve is visible. K=10 is what most production deployments would actually expose to the agent under "replace top-K"; K=1/3/5 give finer-grained signal on rank quality.
- `--pool-sizes A,B,C` (default `30,150,600`) — catalog scales to evaluate at. Each scenario runs once per pool size, simulating "what if the agent had N tools registered". For MetaTool with `--sample 1000`, the unique-tool universe is ~183 (plugins appearing as gold for at least one sampled query); `30,100,180` stays at-or-below that ceiling so every cell is meaningful. The default `30,150,600` is tuned for ToolRet-scale catalogs and would silently clamp here.
- `--scenarios N` — limit to first N rows for a smoke run.
- `--seed N` (default `42`) — seed for distractor shuffling.

The merged report splits MetaTool into separate `single-tool` and `multi-tool` panels because their `recall@K` semantics differ — single-tool is binary (0 or 1), multi-tool is fractional (e.g. 0.5 if one of two gold tools is in top-K). Mixing them obscures both.

For a smoke run without downloading anything, point `--corpus` at the committed `benchmark/test-data/synthetic.jsonl` instead.

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

The Rust definition in [`src/corpus.rs`](src/corpus.rs) is canonical. The TS mirror in [`agent/src/types.ts`](agent/src/types.ts) tracks it.

The synthetic fixture at `test-data/synthetic.jsonl` is the smoke-run input. Public corpora (MetaTool, ToolRet) are ingested into the same shape via the `ingest` subcommand. Per ADR-0006, raw downloads live under `fixtures/` (gitignored) and the normalized snapshot is committed under `test-data/`. Provenance for each shipped corpus file is in [`test-data/SOURCES.md`](test-data/SOURCES.md).

MetaTool-specific notes: plugins ship without parameter schemas, so `input_schema` and `output_schema` are emitted as `{}`. Per-row `candidate_pool` carries only the gold tool(s); the runner pools distractors across all scenarios at retrieval time. To exercise the full 199-plugin universe (rather than the ~183 referenced as gold at `--sample 1000`), raise `--sample` or extend the runner with a side-loaded distractor list (out of scope for v0.1.1).

## Agentic suite (mode c — coming soon)

🚧 The TS agent layer ships an arm builder, runner, metering, and judges for the v0.1.1 harness slice but is not yet wired to a MetaTool corpus. Once mode (c) lands, the entry point is [`agent/README.md`](agent/README.md). Requires API keys.

## Generating the merged report

After the suites have written their JSONL outputs:

```bash
pnpm -F @ratel-ai/benchmark report
```

By default this auto-discovers every `*retrieval.jsonl` under `benchmark/results/` (so a MetaTool pass and a future ToolRet pass appear side by side, one panel per corpus inferred from scenario-id prefix), reads `benchmark/agent/results/agent.jsonl`, and writes `benchmark/results/REPORT.md`. To pin the inputs explicitly:

```bash
pnpm -F @ratel-ai/benchmark report \
  --agent benchmark/agent/results/agent.jsonl \
  --retrieval benchmark/results/metatool-retrieval.jsonl \
  --retrieval benchmark/results/toolret-retrieval.jsonl \
  --output benchmark/results/REPORT.md
```

Pass `--retrieval` once per file. The retrieval section reports both mean and median per `(corpus, subset, k, pool_size)` cell — useful for MetaTool, where most queries hit gold at rank 1 but a long tail of misses pulls the mean below the median, and where multi-tool queries (gold-set size > 1) need their own panel because their recall is fractional.
