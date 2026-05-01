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
- ✅ **ToolRet — IR / autonomous-discovery retrieval (gateway path).** Measures whether our index ranks correctly when the agent emits an IR-shaped query mid-loop (e.g. `searchTools("a tool that converts currency")`). 7,961 retrieval tasks across 35 sub-corpora over a 44,453-tool catalog (Apache-2.0). _ADR-0006 mode (b)._

**Agentic** — end-to-end agent runs with token cost + correctness signals. Requires API keys.

- 🚧 **MetaTool tasks + LLM-as-judge.** _Coming soon._ Runs control + Ratel hybrid arms on MetaTool user-task queries with stubbed tool responses; LLM scores answer quality and selection coherence. Reports input/output tokens, cache hit rate, and $-cost at realistic catalog sizes. _ADR-0006 mode (c)._

The two retrieval-only modes ship today; mode (c) is still pending. All three share the harness contract and the corpus format below.

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

Emits one JSONL row per `(scenario, pool_size, k)` cell with recall@K, precision@K, MRR@K, hit@K, and nDCG@K (binary relevance). One BM25 ranking per query is sliced at every K cutoff, so adding more K values is essentially free.

Tunables:

- `--corpus PATH` — JSONL corpus to evaluate. Above we point at the file produced by step 1.
- `--output PATH` (default `benchmark/results/retrieval.jsonl`) — where to write the metrics JSONL. Gitignored.
- `--top-k A,B,C` (default `1,3,5,10`) — comma-separated K cutoffs. The report renders one row per K so the degradation curve is visible. K=10 is what most production deployments would actually expose to the agent under "replace top-K"; K=1/3/5 give finer-grained signal on rank quality.
- `--pool-sizes A,B,C` (default `30,150,600`) — catalog scales to evaluate at. Each scenario runs once per pool size, simulating "what if the agent had N tools registered". For MetaTool with `--sample 1000`, the unique-tool universe is ~183 (plugins appearing as gold for at least one sampled query); `30,100,180` stays at-or-below that ceiling so every cell is meaningful. The default `30,150,600` is tuned for ToolRet-scale catalogs and would silently clamp here.
- `--scenarios N` — limit to first N rows for a smoke run.
- `--seed N` (default `42`) — seed for distractor shuffling.

The merged report splits MetaTool into separate `single-tool` and `multi-tool` panels because their `recall@K` semantics differ — single-tool is binary (0 or 1), multi-tool is fractional (e.g. 0.5 if one of two gold tools is in top-K). Mixing them obscures both.

For a smoke run without downloading anything, point `--corpus` at the committed `benchmark/test-data/synthetic.jsonl` instead.

## Quickstart: ToolRet retrieval-only (mode b)

Same shape as mode (a): one ingest, one retrieval pass.

### 1. Ingest ToolRet

```bash
cargo run -p ratel-benchmark --release -- ingest toolret --download
```

`--download` pulls 38 Parquet files (3 tool subsets + 35 query sub-corpora) from the upstream HuggingFace datasets via `curl` into `benchmark/fixtures/toolret/` (gitignored), then writes the full normalized corpus to `benchmark/test-data/toolret.jsonl`. **No sampling** — every upstream query is kept (rows whose gold tools aren't in the published catalog are dropped, ~5 of 7,961). Re-running without `--download` against the cached fixtures produces a byte-identical JSONL.

The scenario `prompt` is ToolRet's `instruction` field with the `Given a … task, retrieve tools that …` wrapper stripped. Stripping reduces uniform noise across all arms — same delta either way, just a cleaner BM25 input. The unwrapped `instruction` is the IR-shaped retrieval query an agent would emit at the gateway, which is the path mode (b) is meant to measure (the user-task / replace path is mode (a)'s job).

Tunables (`... ingest toolret --help` for the full list):

- `--download` — pull upstream parquet via `curl` before ingesting. Drop the flag to re-ingest pre-existing files.
- `--fixtures-dir PATH` (default `benchmark/fixtures/toolret`) — where downloaded parquet lives, laid out as `<dir>/tools/<subset>.parquet` and `<dir>/queries/<subset>.parquet`.
- `--output PATH` (default `benchmark/test-data/toolret.jsonl`) — where to write the normalized JSONL.

### 2. Run retrieval

```bash
cargo run -p ratel-benchmark --release -- retrieval \
  --corpus benchmark/test-data/toolret.jsonl \
  --output benchmark/results/toolret-retrieval.jsonl \
  --top-k 1,3,5,10 --pool-sizes 100,1000,7000
```

Same runner as mode (a); only the corpus and pool sizes change. ToolRet's effective universe under gold-only pooling (see below) is ~7,651 unique tools, so `100,1000,7000` spans a small / mid / full-haystack curve. The default `--pool-sizes 30,150,600` is calibrated for MetaTool and would silently undershoot the ToolRet universe.

**Leaderboard caveat.** Per ADR-0006 we mirror MetaTool's gold-only pooling: each scenario's `candidate_pool` carries only its gold tool(s); the runner adds distractors at retrieval time from the union of every other scenario's gold tools. That caps the universe at ~7,651 — well below ToolRet's published 44k pool. **Absolute nDCG numbers from this harness are NOT directly comparable to ToolRet's leaderboard**; relative deltas between arms / index variants are valid. Side-loading the full 44k catalog as a runner-time distractor universe is a tracked follow-up.

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

ToolRet-specific notes: `name` and `description` are derived from the upstream `documentation` JSON (which varies in shape across the three tool subsets — web / code / customized); when no `description` is present the flattener falls back to `functionality` and finally to a deterministic concatenation of remaining string fields, so identical inputs always produce identical `ToolSpec`s. `input_schema` carries `documentation.parameters` verbatim when available, else `{}`. `gold_tools` collects every label with `relevance == 1` (or implicit positive when the field is absent, as in the apibank sub-corpus); rows with negative-only labels or with gold tool ids missing from the published 44k catalog are skipped and counted in the ingest summary.

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
