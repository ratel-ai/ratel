# 5. Benchmark design — what we measure and how

Date: 2026-05-01

## Status

Partially superseded by ADR-0006 (corpus + primary-oracle decisions). The rest — two-layer harness, three-arm primitive, N=5 + median/p90, two-model matrix, catalog scaling, gitignored manual results, fairness/determinism controls — stands.

## Context

Ratel's pitch is that an agent runs **better and cheaper** when its context window holds only the tools it needs. ADR-0003 locked `replace` as the default selection mode; ADR-0004 locked the BM25 indexing rules. Neither ADR is worth anything without empirical evidence: the v0.1.x demo target is "fewer input tokens with Ratel, same task success." We need a benchmark we are willing to cite externally, and we need it before any token-savings claim leaves the repo.

Several axes had to be pinned before code lands, because each one shapes the harness and reversing later means rerunning every cell.

## Decision

**Scope (v0.1.1)**: measure retrieval quality (BM25 alone) and end-to-end agent performance (tokens, tool dynamics, success). MCP tools, CI integration, and BM25 hyperparameter tuning from the benchmark are explicitly out.

**Comparison arms** (per scenario, per model):

- **Control** — every tool in the scenario's candidate pool registered directly with the agent, no Ratel layer. The fat-context floor.
- **Ratel hybrid** — BM25 top-K of the candidate pool plus the two gateway tools (`search_tools`, `invoke_tool`). Mirrors `examples/ai-sdk`. The headline arm.
- **Oracle** — only the gold tools for that scenario. The "model can't do better than this" upper bound.

Retrieval-only metrics (recall@K, MRR, hit-rate) are computed independently and merged into the report.

**Catalog scaling**: control arm runs at three pool sizes (small ~30, medium ~150, large ~600) so the report shows how baseline degrades with scale; hybrid and oracle run against large only, so the comparison is fair to Ratel.

**Corpus**: ToolBench (RapidAPI, ~16k APIs, real instructions with gold tool calls). A normalized JSONL format wraps it; a small synthetic fixture mirrors the format so tests and smoke runs work without the real corpus. Tool execution uses the dataset's cached responses for gold-call args; unknown args return a structured no-data stub. The agent never hits real RapidAPI.

**Correctness oracle**: programmatic tool-call assertions against the gold trace are primary; LLM-as-judge on the final output (Anthropic Claude Sonnet 4.6) is secondary, used when programmatic gives no signal or as a tiebreaker. The judge sees only the final text and the scenario's success criteria — never the trace — so it can't reverse-engineer the answer.

**Models**: gpt-5.4-mini (OpenAI) + claude-sonnet-4-6 (Anthropic). Single small model and single frontier-class model. Multi-provider matrix proves savings hold across token-cache regimes.

**Variance**: N=5 runs per `(scenario, arm, model)` cell; report median + p90 + IQR. Temperature=0 + provider seed where supported, but determinism is not assumed — N=5 surfaces real variance.

**Harness layout (two layers)**:

- `benchmark/` (existing Rust crate) — corpus loader, retrieval-only metrics, runner CLI. Fast, deterministic, no API.
- `benchmark/agent/` (new TS pnpm package) — arm builders, ToolLoopAgent runner, metering, judges, aggregator. Drives the Vercel AI SDK.
- A merge step joins both JSONL outputs into a single markdown report.

**Results storage**: gitignored under `benchmark/results/` and `benchmark/agent/results/`. Manual runs only for v0.1.1 — no CI, no committed numbers. The README documents how to reproduce.

**Determinism, fairness, trust controls** that the harness enforces:

- Pin model versions (full IDs), corpus snapshot SHA, BM25 params, top-K, step cap, prompt template into the JSONL row.
- Seeded scenario sampling and seeded per-run tool-list ordering, to expose any order-bias.
- Per-run wall-clock timeout, per-run token cap, per-cell and global dollar caps.
- Resumable: each cell writes its row independently; re-runs skip completed cells unless forced.
- Cross-arm parity: same prompt, same model, same step cap, same temperature, same stub responses. Only the tool list differs.

## Consequences

- The headline number ("Ratel saves X% input tokens, no measurable quality loss") becomes a single citable row from the merged report — no hand-waving.
- The oracle arm answers a question the control–hybrid comparison alone cannot: is hybrid losing quality vs the model's ceiling, or just vs the fat baseline? Without it, every "loss" looks like Ratel's fault.
- Catalog scaling exposes the regime where Ratel matters: at small pools the savings are small, at large pools they're the headline. Skipping this would make us look weaker than we are on small toy catalogs.
- Synthetic fixture means CI and contributor onboarding don't need ToolBench access — the smoke run is reproducible from a clean clone with API keys.
- Gitignored results means the repo doesn't accumulate stale numbers. Trade-off: no historical record in git; if we want one, a future ADR adds a "release manifest" file capturing the numbers tagged at each release.
- Two-layer harness means two CLIs and one merge step, not one. Trade-off: more surface area, but each layer iterates independently — retrieval quality changes don't pay the LLM cost, agent-loop changes don't recompute BM25.
- N=5 with two models and three arms across catalog scaling means run-count grows multiplicatively. The dollar-budget guards exist precisely so a misconfiguration can't blow through the budget; the resumable runner makes long campaigns safe to interrupt.
- Rejected: a single-arm benchmark that just shows token deltas. Without oracle and without scaling, the numbers are unverifiable claims.
- Rejected: LLM-as-judge as the primary oracle. Programmatic assertions are deterministic and free; the judge is a fallback, not the foundation.
- Rejected: committing results to the repo. Version-controlled metrics rot fast and create pressure to suppress regressions. Manual-run + reproduce-on-demand is healthier for v0.1.1.
- Future ADRs may supersede: per-framework arm definitions once non-AI-SDK integrations land; CI smoke gates once a stable subset settles; a release-manifest format if we want historical numbers under git.
