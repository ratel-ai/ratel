# `benchmark/`

> **Moved → [ratel-ai/ratel-bench](https://github.com/ratel-ai/ratel-bench)**
>
> The benchmark harness now lives in its own public repo and pins the published `ratel-ai-core` and `@ratel-ai/sdk` artifacts directly. This README is being kept temporarily for backlinks and will be removed shortly. New work and the latest results go in the new repo.

Two-layer harness measuring Ratel's retrieval quality and (eventually) agent-loop token savings. Backs every "Ratel does X better" claim. New product features that touch retrieval or context shape are expected to add a corresponding scenario before being declared done.

**Latest results: [`RESULTS.md`](RESULTS.md)** — narrative breakdown across Claude (Sonnet, Opus), `glm-5.1:cloud`, and local `qwen3.5`.

## Where Ratel is most valuable today

| your situation | Ratel's value today |
|---|---|
| Local model + large catalog | **Critical.** qwen3.5 at pool=100 goes from 8% → 77% (-57% input tokens, -36% wall time). |
| Open-source cloud + large catalog | **Strong win.** glm-5.1 at pool=180: **+12 pp** accuracy and **-85%** input tokens. |
| Frontier (Sonnet) + large catalog | **Cost-driven win.** Sonnet 4.6 at pool=180: **-82%** input tokens, **-68%** $; -8 pp accuracy. |
| Frontier (Opus) + large catalog | **Competitive win.** Opus 4.6 pool=180: **+8 pp** accuracy and **-72%** tokens (discovery-tool arm). Opus 4.7 pool=180: ≈parity (-1.7 pp) with **-81%** tokens — Anthropic's own tool-search-tool loses **-8 pp** on the same setup. |
| Any model + tiny catalog (≤30) | Skip Ratel — pool fits in the prompt cleanly. |

Full per-pool breakdown and methodology in [`RESULTS.md`](RESULTS.md).

Methodology, eval modes, run commands, and corpus format are documented in the new repo:

- [`README.md`](https://github.com/ratel-ai/ratel-bench/blob/main/README.md) — top-level harness overview, eval modes, run commands
- [`retrieval/README.md`](https://github.com/ratel-ai/ratel-bench/blob/main/retrieval/README.md) — Rust retrieval layer (modes a + b)
- [`agent/README.md`](https://github.com/ratel-ai/ratel-bench/blob/main/agent/README.md) — TS agent campaign (mode c), defaults, flags

Locked decisions still live with the rest of the Ratel ADRs:

- [`docs/adr/0005-benchmark-design.md`](../docs/adr/0005-benchmark-design.md) — overall harness (arms, models, variance, results storage)
- [`docs/adr/0006-benchmark-corpus-and-eval-modes.md`](../docs/adr/0006-benchmark-corpus-and-eval-modes.md) — corpus pivot + the three eval modes
- [`docs/adr/0007-benchmark-corpus-not-snapshotted.md`](../docs/adr/0007-benchmark-corpus-not-snapshotted.md) — corpus is ingested locally; no committed snapshot, no MetaTool sampling
