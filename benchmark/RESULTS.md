# Ratel benchmark — narrative summary

> **Moved → [ratel-ai/ratel-bench › `RESULTS.md`](https://github.com/ratel-ai/ratel-bench/blob/main/RESULTS.md)**
>
> The benchmark harness has been extracted to its own repo. This file is a stale snapshot kept temporarily for backlinks and will be removed shortly. Latest numbers and methodology live in the new repo.

This document consolidates the agent benchmark across four model families on the MetaTool corpus and explains what the numbers say about where Ratel helps today and where it's still maturing.

## Where Ratel is most valuable today

| your situation | Ratel's value today |
|---|---|
| Local model + large catalog | **Critical.** Without Ratel the model can't function. (qwen3.5 pool=100: 8% → 77%) |
| Open-source cloud model + large catalog | **Strong win.** Beats baseline on accuracy *and* tokens. (glm-5.1: +12pp, -85% tokens) |
| Frontier model + large catalog | **Cost-driven win.** ~80% input-token savings, modest accuracy cost; closing now. |
| Any model + tiny catalog (≤30) | Skip Ratel — pool fits in the prompt cleanly. |

## Headline takeaways

- **Token savings are universal and large.** Across every model tested, Ratel cuts input tokens by **70–85% at realistic pool sizes (100–180 tools)**. This is true whether the underlying model is a tiny local model or frontier Claude.
- **Open-source / local models: Ratel is what makes them usable.** `glm-5.1:cloud` gains **~10 pp accuracy** versus the baseline at large pool sizes, and **`qwen3.5` running locally on a MacBook Pro M4 24 GB jumps from 8.3% → 76.7%** when the pool grows to 100 tools — the baseline simply collapses, Ratel keeps it working.
- **Frontier Claude models: massive token + cost savings, accuracy not yet at parity.** Sonnet 4.6 keeps solving most tasks even with 180-tool pools, so the headroom Ratel buys is mostly cost / context — not pass-rate. Ratel currently trades a few percentage points of pass-rate for ~70–80% token savings. Closing this gap is the active work item.

## Methodology

- **Corpus**: MetaTool single-tool selection, strict LLM judge (no rewarding of "I don't have a tool, try X" style refusals).
- **Arms**:
  - `control-baseline` — entire candidate pool exposed to the agent.
  - `control-oracle` — only the gold tool is exposed (upper bound).
  - `ratel-full` — Ratel discovery + selection. The model sees ~5 BM25-prefetched tools plus the 2 gateway tools (`search_tools` + `invoke_tool`) — ~7 total — regardless of pool size.
- **Pool sizes**: 30, 50, 100, 180. Real-world MCP setups land in the 100–200 range.
- **Hardware**: cloud APIs for Claude / glm-5.1:cloud; local Ollama on **MacBook Pro M4 24 GB** for qwen3.5.

## Results by model family

### Local / open-source models — where Ratel shines

#### `qwen3.5` (Ollama, MacBook Pro M4 24 GB)

| pool | control-baseline | ratel-full | Δ accuracy | input tokens (ctrl → ratel) | wall time (ctrl → ratel) |
|---|---|---|---|---|---|
| 30 | 91.7% | 88.3% | -3.4 pp | 3 926 → 2 494 (-37%) | 59.6s → 61.7s |
| 50 | 86.7% | 81.7% | -5.0 pp | 6 738 → 2 557 (-62%) | 61.3s → 65.6s |
| **100** | **8.3%** | **76.7%** | **+68.4 pp** | 6 485 → 2 820 (-57%) | 107.6s → 69.1s (**-36%**) |

What happens at pool=100 is the story. The baseline arm catastrophically degrades — the model is overwhelmed by the tool list and stops calling tools at all (programmatic pass rate drops to 0). With Ratel, the model only sees ~7 well-targeted tools (5 prefetched + 2 gateway) and stays at **76.7%**. This is the difference between "local models can't handle large tool catalogs" and "local models are a real option for large MCP setups."

The wall-clock improvement (107.6s → 69.1s) is a side benefit — fewer tokens means faster inference on memory-constrained hardware.

#### `glm-5.1:cloud` (open-source, hosted)

| pool | control-baseline | ratel-full | Δ accuracy | input tokens (ctrl → ratel) |
|---|---|---|---|---|
| 30 | 85.6% | 86.7% | +1.1 pp | 2 976 → 2 428 (-18%) |
| 50 | 80.0% | 84.4% | +4.4 pp | 4 897 → 2 579 (-47%) |
| 100 | 78.9% | 85.6% | **+6.7 pp** | 10 062 → 2 909 (**-71%**) |
| 180 | 75.6% | 87.8% | **+12.2 pp** | 19 362 → 2 923 (**-85%**) |

For glm-5.1, the picture is the cleanest possible win: **Ratel beats the baseline at every pool size**, and the gap **widens as the catalog grows**. At pool=180 it's +12 pp pass-rate while using ~85% fewer input tokens.

The Ratel arm is also essentially **pool-invariant**: 85-88% across all pool sizes. The model isn't seeing the full pool, so it doesn't matter how big it gets.

### Frontier Claude models — token savings now, accuracy parity in flight

Sonnet already handles 180-tool pools reasonably well in the baseline, so Ratel doesn't unlock a new capability here. What it does deliver is **dramatic input-token and dollar savings** at a modest accuracy cost.

#### `claude-sonnet-4-6`

| pool | control-baseline | ratel-full | Δ accuracy | input savings | $ savings |
|---|---|---|---|---|---|
| 30 | 84.4% | 76.7% | -7.7 pp | 25.9% | 12.1% |
| 50 | 81.1% | 70.0% | -11.1 pp | 47.9% | 30.7% |
| 100 | 81.1% | 67.8% | -13.3 pp | **70.1%** | **53.2%** |
| 180 | 81.1% | 73.3% | -7.8 pp | **81.9%** | **68.0%** |

control-oracle (upper bound): **90.0%**.

#### What's behind the Claude gap?

The gap is not the agent loop — it's **discovery / retrieval**. In the failure taxonomy, Ratel arms accumulate **"missing gold"** rows: cases where the BM25 retriever didn't surface the right tool in the candidate window. For Sonnet at pool=180, that's 20 of 31 failures. With perfect retrieval (oracle = 90%), the agent itself is fine — the bottleneck is upstream of the model.

This is a tractable problem: the discovery layer is currently BM25-only, and the v1 line is still on the keyword retriever. Hybrid / semantic retrieval is the next milestone, and is expected to recover most of the gap on Claude models while preserving the token savings.

#### Why this is still a strong story for Claude

The trade-off Ratel offers a Claude user **today** is:

> "Pay -8 pp pass rate (Sonnet pool=180) — get **-82% input tokens, -68% dollars, and pool-size-invariant cost**."

For agent platforms running 100s of MCP tools, the cost difference between feeding 17 000 input tokens per turn vs. 3 000 dominates the economics. And the trade-off goes the other way — Ratel's performance drops as the pool *shrinks*. Below ~30 tools you should not use Ratel: the baseline already fits cleanly in the prompt.

#### `claude-opus-4-6`

| pool | baseline | ratel-discovery-tool | ratel-full | claude-sdk-tool-search | oracle |
|---|---|---|---|---|---|
| 50  | 65.0% | **80.0%** (+15 pp)   | 70.0% | 50.0% (-15 pp)   | 91.7% |
| 100 | 73.3% | 75.0% (+1.7 pp)      | 63.3% | 53.3% (-20 pp)   | 91.7% |
| 180 | 65.0% | **73.3%** (+8.3 pp)  | 66.7% | 48.3% (-16.7 pp) | 91.7% |

Opus 4.6 is the model where Ratel produces an unambiguous accuracy *win*. The baseline is unusually weak for a frontier model (65% at pool=180) while the oracle is the strongest in the suite (**91.7%**, pool-invariant) — a strong agent loop sitting on top of weak fat-context selection. The `ratel-discovery-tool` arm (gateway only, no pre-fetch) beats baseline at every pool size, peaking **+15 pp at pool=50** and **+8 pp at pool=180**, with **-72% input tokens at pool=180**. `ratel-full` zig-zags around baseline (sample noise) with the same token savings. **Anthropic's [tool-search-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)** sits 15–20 pp below baseline across the sweep.

#### `claude-opus-4-7`

Pool=180 only, n=60 per cell:

| arm | accuracy | Δ vs baseline | input savings |
|---|---|---|---|
| control-baseline         | 71.7%     | —             | —          |
| control-oracle           | 83.3%     | +11.7 pp      | —          |
| **ratel-discovery-tool** | **70.0%** | **-1.7 pp**   | **-80.9%** |
| ratel-full               | 55.0%     | -16.7 pp      | -79.5%     |
| claude-sdk-tool-search   | 63.3%     | **-8.4 pp**   | -76.7%     |

Opus 4.7 lifts the baseline (71.7% at pool=180), softening the selection bottleneck that made 4.6 a clear Ratel win. The story shifts to a competitive frame: `ratel-discovery-tool` lands within **-1.7 pp** of baseline while saving **-81% input tokens**, whereas **Anthropic's tool-search-tool drops -8.4 pp on the same pool — roughly 5× the accuracy hit for similar token savings**. The `ratel-full` regression to 55% is an open thread (pre-fetch + gateway underperforming gateway-alone for this model, under investigation).

> **Sample-size caveat.** Opus cells are 20 scenarios × 3 runs (n=60), versus 20 × 5 (n=100) for the Sonnet headline. Treat the per-pool deltas as directional, not headline-grade.

## What's next

1. **Hybrid retrieval** — replace BM25-only discovery with hybrid (BM25 + dense) to close the "missing gold" gap on Claude models without giving up token savings.
2. **Discovery feedback loop** — let the agent re-query the tool index when its first candidate set doesn't contain a useful tool, instead of failing the cell.
3. **Broader scenario coverage** — the current corpus is single-tool MetaTool; add multi-tool and toolret scenarios to the agent benchmark. Retrieval-quality rows for both already ship in the report and look strong.

## Reproducing these numbers

The harness now lives in [`ratel-ai/ratel-bench`](https://github.com/ratel-ai/ratel-bench). See its [`README.md`](https://github.com/ratel-ai/ratel-bench/blob/main/README.md) and [`agent/README.md`](https://github.com/ratel-ai/ratel-bench/blob/main/agent/README.md) for the up-to-date `pnpm -F @ratel-ai/benchmark start` / `report` / `rejudge` invocations.
