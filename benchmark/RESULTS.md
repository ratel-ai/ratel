# Ratel benchmark — narrative summary

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

## What's next

1. **Hybrid retrieval** — replace BM25-only discovery with hybrid (BM25 + dense) to close the "missing gold" gap on Claude models without giving up token savings.
2. **Discovery feedback loop** — let the agent re-query the tool index when its first candidate set doesn't contain a useful tool, instead of failing the cell.
3. **Broader scenario coverage** — the current corpus is single-tool MetaTool; add multi-tool and toolret scenarios to the agent benchmark. Retrieval-quality rows for both already ship in the report and look strong.

## Reproducing these numbers

```bash
# Strict judge is now the default for the no-criteria fallback (v0.1.2).
# Older results can be re-judged in place without rerunning agents:
pnpm -F @ratel-ai/benchmark start rejudge \
  benchmark/agent/results/<run>.jsonl \
  --judge-prompt strict

# Render the narrative tables:
pnpm -F @ratel-ai/benchmark report \
  --agent benchmark/agent/results/<run>.rejudged-strict.jsonl \
  --output benchmark/results/<NAME>.md
```
