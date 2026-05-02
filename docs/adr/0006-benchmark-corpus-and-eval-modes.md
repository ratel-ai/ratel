# 6. Benchmark corpus and eval modes — MetaTool + ToolRet

Date: 2026-05-01

## Status

Accepted. Supersedes the corpus and primary-oracle decisions in ADR-0005; the rest of 0005 (two-layer harness, N=5 + median/p90, two-model matrix, catalog scaling, gitignored manual results, fairness/determinism controls) stands.

Partially superseded by ADR-0007: the "snapshot normalized JSONL into the repo" stance and the MetaTool sampling cap are dropped. Two retrieval modes, the gold-only pooling, and the judge stack stand.

## Context

ADR-0005 locked **ToolBench** as the corpus. Two issues surfaced when we went to ingest it:

1. **Project activity.** ToolBench's last meaningful release was mid-2024; the upstream project is effectively dormant. Citing a dormant corpus is a credibility tax.
2. **Structural mismatch with our `Scenario` shape.** Gold trajectories are DFS search trees, not linear traces — extracting a single canonical "gold path" forces us to invent a policy the dataset doesn't pin (leftmost successful leaf? marked answer? shortest?). Tools are bundled at "tool with `api_list[]`" granularity, requiring a flattening step to map onto our 1:1 tool model. Both are doable, neither is free.

A wider survey of the tool-benchmarking landscape (BFCL, ToolBench, MetaTool, ToolRet, τ-bench, NexusRaven, ComplexFuncBench) revealed a more consequential point: **no widely-cited benchmark explicitly varies catalog size as the independent variable while measuring end-to-end agent token cost.** BFCL exposes 2–4 tools per prompt — the wrong regime. ToolRet is retrieval-only at scale (43k tools) but no agent loop. MetaTool measures tool-selection accuracy with realistic user queries but small catalogs. The opportunity is to *combine* these — and that's what ADR-0005's harness was always meant to do — but the corpus needs to fit.

A second realization: Ratel exposes two distinct selection paths (per ADR-0003) and they deserve separate measurement.

- **Pre-fetch / replace path.** We silently choose tools and inject them before the agent's turn. The query that drives selection is the **user's natural-language task**.
- **Agent-discovery / gateway path.** The agent calls `searchTools` mid-loop. The query that drives selection is the **agent's IR-shaped synthesis** ("a tool that converts currency"), not the user task.

These two paths can succeed or fail independently — strong BM25 over user queries doesn't guarantee strong BM25 over agent-emitted retrieval queries — and benchmarking only one would mask half of Ratel's surface area.

## Decision

### Corpus

Drop ToolBench. Adopt two corpora:

- **MetaTool** ([HowieHwong/MetaTool](https://github.com/HowieHwong/MetaTool), MIT, ~21k queries: 20,630 single-tool + 497 multi-tool). Tools are OpenAI plugin descriptions (name + description, no parameter schemas). Queries are user-task-shaped.
- **ToolRet** ([mangopy/tool-retrieval-benchmark](https://github.com/mangopy/tool-retrieval-benchmark), Apache-2.0, 7,600 retrieval tasks over a 43k-tool corpus). Tools include parameter schemas. Queries are IR-shaped, with per-query `labels[]` carrying gold relevance.

Both are redistributable. We snapshot normalized JSONL into the repo (cap MetaTool to a sampled subset to keep the snapshot small) and gitignore the raw downloads under `benchmark/fixtures/`.

### Three eval modes

**(a) MetaTool retrieval-only — pre-fetch accuracy.**
Run our BM25 over MetaTool's plugin descriptions for each user query. Score `recall@K` / `MRR` / `hit@K` against the gold tool name(s). This measures the **replace** path: when Ratel silently chooses tools before the agent runs, given a real user query, do we surface the right tool? Fast, deterministic, $0.

**(b) ToolRet retrieval-only — discovery accuracy.**
Run our BM25 over ToolRet's tool corpus for each retrieval query. Score `recall@K` / `MRR` / `nDCG` against the labeled relevance. This measures the **gateway** path: when the agent calls `searchTools` with an IR-shaped query, does our index rank correctly at large catalog scale? Fast, deterministic, $0. Also produces numbers directly comparable to ToolRet's published leaderboard, giving us external validation of the retrieval layer.

**(c) MetaTool tasks + LLM-as-judge — end-to-end agent benchmark.**
Run control + Ratel hybrid arms on MetaTool's user-task queries. Tools execute as **stubs** — neither MetaTool nor ToolRet ships cached real responses, so tool calls return a structured "ok" placeholder. LLM-as-judge scores the agent's final answer for **tool-selection coherence and answer quality**, not full task completion. Measures token cost (input/output/cached, $-cost) and an approximate correctness signal at realistic catalog sizes.

### Arm and judge changes flowing from this

- **Oracle drops from the default arm list** for these corpora. Without gold args or cached responses it can't anchor an "upper bound on what the model could do given perfect tool selection" the way 0005 envisaged. It stays available behind a flag (register only `gold_tools`) for sanity checks, but the headline runs use control + hybrid.
- **Programmatic judge becomes selection-only.** When `gold_trace` is empty (always, on these corpora), the programmatic verdict is `pass` iff `effective_tool_ids ∩ gold_tools ≠ ∅`. Useful as a coarse selection check.
- **LLM-as-judge promotes from secondary to primary** for mode (c). Programmatic remains as a sanity bound; the headline correctness number is the judge.
- **`gold_trace` becomes optional** on the `Scenario` type, so the harness accepts selection-only corpora without contortions. Existing scenarios that *do* have a gold trace continue to use the trace-match logic.

## Consequences

- **Sharper headline claim.** "At equal selection accuracy, Ratel hybrid uses N% fewer input tokens than control on real-world tool catalogs." Defensible without gold-trace execution, and cleanly separable across the two retrieval paths.
- **External validation.** Mode (b) compares directly against ToolRet's leaderboard. If our BM25 numbers diverge from theirs we have a bug; if they match, the retrieval layer is independently credible before any agent run.
- **Lower friction.** MIT + Apache-2.0 corpora, redistributable, no API keys, no live RapidAPI. Modes (a) and (b) cost $0 and can run in CI eventually.
- **Weaker correctness signal than 0005 promised.** LLM-judge over stubbed tool responses is softer than gold-trace execution. Accepted at v0.1.1 because the headline is about token cost at equal selection accuracy, not full task completion. v0.1.2+ revisits with hand-curated MCP scenarios that ship real cached responses (or a StableToolBench-style simulator if we go that direction).
- **Surface area expands deliberately.** Three eval modes instead of one, and the Selector interface earns its keep — we now have concrete reasons (replace vs gateway) for it to be plural.
- **Plan slot.** Mode (c) at full size still costs API spend. The dollar caps from 0005 still apply; we'll start mode (c) at ~50–200 scenarios per pass to keep early runs cheap, then scale.

## Rejected

- **StableToolBench.** Cached-response server eliminates one limitation (stub-only execution) at the cost of a Python service dependency. Marginal gain for v0.1.1's scope; revisit when full-task correctness becomes the headline metric.
- **Hand-curated MCP scenarios at v0.1.1.** Right destination, wrong moment — too much human labor before the harness has shaken out. Deferred to v0.1.2 alongside MCP tools support.
- **Editing ADR-0005.** Per project convention ADRs are immutable once Accepted. This ADR supersedes the affected decisions and references 0005 explicitly; readers of 0005 should look here for the corpus and primary-oracle stance.
