# Benchmark Results

## Overall Scores

| Agent | Model | Tool F1 | Task Correctness | Hydration Recall | Input Tokens | Cost ($) |
| --- | --- | --- | --- | --- | --- | --- |
| Oracle | gemini-3-flash-preview | 0.99 | 0.96 | 1.00 | 134,696 | 0.09 |
| Agentified | gemini-3-flash-preview | 0.93 | 0.92 | 0.97 | 448,551 | 0.25 |
| Baseline | gemini-3-flash-preview | 0.93 | 0.96 | 1.00 | 2,927,990 | 0.52 |
| Oracle | claude-opus-4-6 | 0.99 | 0.94 | 1.00 | 177,643 | 1.39 |
| Agentified | claude-opus-4-6 | 0.93 | 0.94 | 0.99 | 556,830 | 3.46 |
| Baseline | claude-opus-4-6 | 0.97 | 0.97 | 1.00 | 3,917,085 | 20.25 |

### Highlights (gemini-3-flash-preview)

- **Agentified uses ~85% fewer input tokens than Baseline** (448K vs 2.9M) while matching Tool F1 (0.93)
- **Cost drops ~52%** ($0.25 vs $0.52) with Agentified vs Baseline
- Oracle ceiling: 0.99 F1 with 134K tokens

### Highlights (claude-opus-4-6)

- **Agentified uses ~86% fewer input tokens than Baseline** (557K vs 3.9M)
- **Cost drops ~83%** ($3.46 vs $20.25) — massive savings on expensive models
- **Hydration near-parity**: Agentified HR=0.99 vs Baseline HR=1.00
- **F1 gap narrowed**: Agentified 0.93 vs Baseline 0.97 (was 0.87)

## By Category

### gemini-3-flash-preview

| Category | Oracle F1 | Agentified F1 | Baseline F1 | Oracle TC | Agentified TC | Baseline TC |
| --- | --- | --- | --- | --- | --- | --- |
| retrieval | 1.00 | 0.94 | 1.00 | 1.00 | 1.00 | 1.00 |
| action | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| multi-turn | 1.00 | 0.87 | 0.89 | 1.00 | 0.96 | 0.91 |
| negative | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ambiguous | 1.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| cross-domain | 0.96 | 0.94 | 0.82 | 1.00 | 1.00 | 1.00 |
| distractor | 1.00 | 0.97 | 0.97 | 1.00 | 0.60 | 1.00 |
| scale-stress | 0.93 | 0.97 | 0.93 | 0.90 | 1.00 | 1.00 |

### claude-opus-4-6

| Category | Oracle F1 | Agentified F1 | Baseline F1 | Oracle TC | Agentified TC | Baseline TC |
| --- | --- | --- | --- | --- | --- | --- |
| retrieval | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| action | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| multi-turn | 1.00 | 0.81 | 0.83 | 0.96 | 0.95 | 0.96 |
| negative | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| ambiguous | 1.00 | 0.00 | 1.00 | 1.00 | 0.00 | 1.00 |
| cross-domain | 0.96 | 0.94 | 0.96 | 0.98 | 0.98 | 0.98 |
| distractor | 0.96 | 0.93 | 0.97 | 0.80 | 1.00 | 1.00 |
| scale-stress | 1.00 | 1.00 | 1.00 | 0.80 | 0.80 | 0.80 |

## Missing Models

- [ ] `gpt-5`
- [ ] `gpt-5-mini`
- [ ] `gpt-5-nano`
- [ ] `gpt-4o`
- [ ] `claude-sonnet-4-5-20250929`
- [ ] `claude-haiku-4-5-20251001`
- [ ] `gemini-3-pro-preview`
