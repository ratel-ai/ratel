# Benchmark Results

> **Notes on Task Correctness (TC):** TC does not scale linearly across models. Some models (especially gpt-5\* family) produce significantly more reasoning tokens even with fewer tools, inflating costs without proportional TC gains. The TC metric is also sensitive to the model's verbosity and interpretation style — comparing TC across model families is not apples-to-apples.
>
> **Notes on Cost:** Models that reason more (high reasoning token counts) show disproportionately higher costs, particularly in the Agentified and Oracle configurations where fewer tools means less input but more thinking. This is most visible in gpt-5 and gpt-5-mini runs.

## Overall Scores

| Model | Oracle TC | Oracle Time | Oracle Cost | Baseline TC | Baseline Time | Baseline Cost | Agentified TC | Agentified HR | Agentified Time | Agentified Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemini-3-flash-preview | 94% | 379s | $0.09 | 96% | 622s | $0.56 | 96% | 99% | 541s | $0.21 |
| claude-sonnet-4-6 | 96% | 499s | $0.80 | 95% | 692s | $11.50 | 96% | 99% | 687s | $2.16 |
| claude-opus-4-6 | 94% | 699s | $1.45 | 97% | 963s | $19.88 | 93% | 99% | 747s | $3.32 |
| gpt-4o | 91% | 955s | $0.69 | 90% | 558s | $2.53 | 80% | 98% | 303s | $0.54 |
| gpt-5 | 92% | 1348s | $0.78 | 90% | 1805s | $1.08 | 84% | 99% | 1566s | $0.98 |
| gpt-5.4 | 88% | 242s | $0.31 | 93% | 483s | $0.72 | 88% | 99% | 311s | $0.53 |
| gpt-5-mini | 95% | 876s | $0.10 | 92% | 1204s | $0.17 | 84% | 99% | 1060s | $0.14 |

### Highlights (gemini-3-flash-preview)

- **Agentified uses ~84% fewer input tokens than Baseline** (514K vs 3.2M) while beating Baseline F1 (0.91 vs 0.90)
- **Cost drops ~63%** ($0.21 vs $0.56) with Agentified vs Baseline
- Oracle ceiling: 0.99 F1 with 130K tokens

### Highlights (claude-sonnet-4-6)

- **Agentified uses ~84% fewer input tokens than Baseline** (583K vs 3.7M)
- **Cost drops ~81%** ($2.16 vs $11.50)
- **F1 parity**: Agentified matches Baseline at 0.93
- **TC parity**: both at 0.95-0.96

### Highlights (claude-opus-4-6)

- **Agentified uses ~85% fewer input tokens than Baseline** (563K vs 3.8M)
- **Cost drops ~83%** ($3.32 vs $19.88) — massive savings on expensive models
- **Hydration near-parity**: Agentified HR=0.99 vs Baseline HR=1.00
- **F1 gap narrowed**: Agentified 0.93 vs Baseline 0.97

### Highlights (gpt-4o)

- **Agentified uses ~86% fewer input tokens than Baseline** (232K vs 1.6M)
- **Cost drops ~79%** ($0.54 vs $2.53)
- TC lower across all agents — gpt-4o struggles with task correctness on this benchmark

### Highlights (gpt-5)

- **Agentified uses ~78% fewer input tokens than Baseline** (487K vs 2.2M)
- **Cost savings modest at ~9%** ($0.98 vs $1.08) — gpt-5 generates heavy reasoning tokens even with fewer tools, offsetting input savings
- Oracle cost ($0.78) higher than expected due to reasoning overhead

### Highlights (gpt-5.4)

- **Agentified uses ~84% fewer input tokens than Baseline** (260K vs 1.6M)
- **Cost drops ~26%** ($0.53 vs $0.72) — no reasoning tokens, so savings track input reduction better than gpt-5
- **Highest Agentified F1 among OpenAI models** at 0.94
- **Only model where Agentified solves `ambiguous`** (1.00 F1/TC across all agents)

### Highlights (gpt-5-mini)

- **Agentified uses ~79% fewer input tokens than Baseline** (406K vs 2.0M)
- **Cost savings modest at ~18%** ($0.14 vs $0.17) — same reasoning overhead pattern as gpt-5
- Cheapest model overall: full benchmark run for $0.14 with Agentified

## By Category

### gemini-3-flash-preview

| Category | Oracle F1 | Agentified F1 | Baseline F1 | Oracle TC | Agentified TC | Baseline TC |
| --- | --- | --- | --- | --- | --- | --- |
| retrieval | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| action | 1.00 | 1.00 | 0.93 | 1.00 | 1.00 | 1.00 |
| multi-turn | 1.00 | 0.80 | 0.86 | 0.92 | 0.92 | 0.93 |
| negative | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ambiguous | 1.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| cross-domain | 0.96 | 0.78 | 0.77 | 0.98 | 0.98 | 1.00 |
| distractor | 1.00 | 0.97 | 0.97 | 1.00 | 1.00 | 1.00 |
| scale-stress | 0.93 | 0.97 | 0.89 | 0.80 | 1.00 | 1.00 |

### claude-sonnet-4-6

| Category | Oracle F1 | Agentified F1 | Baseline F1 | Oracle TC | Agentified TC | Baseline TC |
| --- | --- | --- | --- | --- | --- | --- |
| retrieval | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| action | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| multi-turn | 1.00 | 0.75 | 0.77 | 1.00 | 0.88 | 1.00 |
| negative | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ambiguous | 1.00 | 0.00 | 0.00 | 1.00 | 0.00 | 0.00 |
| cross-domain | 0.92 | 0.94 | 0.94 | 0.86 | 0.98 | 1.00 |
| distractor | 0.96 | 0.97 | 0.97 | 0.80 | 1.00 | 1.00 |
| scale-stress | 1.00 | 0.96 | 0.96 | 1.00 | 1.00 | 0.80 |

### claude-opus-4-6

| Category | Oracle F1 | Agentified F1 | Baseline F1 | Oracle TC | Agentified TC | Baseline TC |
| --- | --- | --- | --- | --- | --- | --- |
| retrieval | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| action | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| multi-turn | 1.00 | 0.84 | 0.80 | 0.98 | 0.91 | 1.00 |
| negative | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ambiguous | 1.00 | 0.00 | 1.00 | 1.00 | 0.00 | 1.00 |
| cross-domain | 0.96 | 0.89 | 0.96 | 0.98 | 0.98 | 0.98 |
| distractor | 0.96 | 0.93 | 0.97 | 0.80 | 1.00 | 1.00 |
| scale-stress | 1.00 | 1.00 | 1.00 | 0.80 | 0.80 | 0.80 |

### gpt-4o

| Category | Oracle F1 | Agentified F1 | Baseline F1 | Oracle TC | Agentified TC | Baseline TC |
| --- | --- | --- | --- | --- | --- | --- |
| retrieval | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| action | 1.00 | 0.97 | 1.00 | 1.00 | 0.86 | 1.00 |
| multi-turn | 0.95 | 0.82 | 0.90 | 0.85 | 0.63 | 0.76 |
| negative | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ambiguous | 1.00 | 0.00 | 0.00 | 1.00 | 0.00 | 0.00 |
| cross-domain | 0.96 | 0.82 | 0.85 | 0.96 | 0.84 | 0.98 |
| distractor | 1.00 | 0.96 | 0.87 | 1.00 | 0.60 | 0.70 |
| scale-stress | 0.93 | 0.93 | 1.00 | 0.50 | 0.80 | 1.00 |

### gpt-5

| Category | Oracle F1 | Agentified F1 | Baseline F1 | Oracle TC | Agentified TC | Baseline TC |
| --- | --- | --- | --- | --- | --- | --- |
| retrieval | 1.00 | 0.95 | 1.00 | 1.00 | 1.00 | 1.00 |
| action | 1.00 | 0.91 | 1.00 | 1.00 | 0.86 | 1.00 |
| multi-turn | 0.96 | 0.79 | 0.82 | 0.91 | 0.76 | 0.90 |
| negative | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ambiguous | 1.00 | 0.00 | 0.00 | 1.00 | 0.00 | 0.00 |
| cross-domain | 1.00 | 0.76 | 0.86 | 1.00 | 0.80 | 0.90 |
| distractor | 1.00 | 1.00 | 0.87 | 1.00 | 1.00 | 1.00 |
| scale-stress | 0.93 | 0.90 | 0.95 | 0.50 | 0.60 | 0.60 |

### gpt-5.4

| Category | Oracle F1 | Agentified F1 | Baseline F1 | Oracle TC | Agentified TC | Baseline TC |
| --- | --- | --- | --- | --- | --- | --- |
| retrieval | 1.00 | 1.00 | 0.94 | 1.00 | 1.00 | 1.00 |
| action | 1.00 | 0.93 | 1.00 | 1.00 | 0.86 | 1.00 |
| multi-turn | 0.98 | 0.85 | 0.82 | 0.66 | 0.65 | 0.72 |
| negative | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ambiguous | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| cross-domain | 0.96 | 0.83 | 0.91 | 0.98 | 0.90 | 0.98 |
| distractor | 1.00 | 1.00 | 0.97 | 0.80 | 1.00 | 1.00 |
| scale-stress | 0.93 | 0.93 | 1.00 | 0.60 | 0.70 | 0.79 |

### gpt-5-mini

| Category | Oracle F1 | Agentified F1 | Baseline F1 | Oracle TC | Agentified TC | Baseline TC |
| --- | --- | --- | --- | --- | --- | --- |
| retrieval | 1.00 | 1.00 | 0.94 | 0.94 | 0.94 | 1.00 |
| action | 1.00 | 0.93 | 1.00 | 1.00 | 0.86 | 1.00 |
| multi-turn | 0.98 | 0.82 | 0.96 | 0.95 | 0.85 | 0.90 |
| negative | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ambiguous | 1.00 | 0.00 | 0.00 | 1.00 | 0.00 | 0.00 |
| cross-domain | 0.96 | 0.85 | 0.98 | 0.96 | 0.80 | 1.00 |
| distractor | 1.00 | 0.88 | 0.85 | 1.00 | 0.80 | 1.00 |
| scale-stress | 1.00 | 0.91 | 0.93 | 0.80 | 0.80 | 0.70 |
