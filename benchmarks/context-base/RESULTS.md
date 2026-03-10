# Benchmark Results

Latest results from `2026-03-03`.

## Overall Scores

| Agent | Model | Tool F1 | Task Correctness | Hydration Recall | Input Tokens | Cost ($) |
| --- | --- | --- | --- | --- | --- | --- |
| Oracle | gemini-3-flash-preview | 0.99 | 0.96 | 1.00 | 134,696 | 0.09 |
| Agentified | gemini-3-flash-preview | 0.93 | 0.92 | 0.97 | 448,551 | 0.25 |
| Baseline | gemini-3-flash-preview | 0.93 | 0.96 | 1.00 | 2,927,990 | 0.52 |

### Highlights

- **Agentified uses ~85% fewer input tokens than Baseline** (448K vs 2.9M) while matching Tool F1 (0.93)
- **Cost drops ~52%** ($0.25 vs $0.52) with Agentified vs Baseline
- Oracle sets the ceiling at 0.99 F1 with only 134K tokens

## By Category

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

## Missing Models

Results only exist for **gemini-3-flash-preview**. The following models are configured in the pricing table but have no benchmark results yet:

- [ ] `gpt-5`
- [ ] `gpt-5-mini`
- [ ] `gpt-5-nano`
- [ ] `gpt-4o`
- [ ] `claude-sonnet-4-5-20250929`
- [ ] `claude-haiku-4-5-20251001`
- [ ] `claude-opus-4-6`
- [ ] `gemini-3-pro-preview`
