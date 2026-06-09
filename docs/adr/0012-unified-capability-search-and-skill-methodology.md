# 12. Unified capability search + two-path skill methodology

Date: 2026-06-09

## Status

Accepted

Supersedes [11. First-class skills](0011-first-class-skills.md).

## Context

ADR-0011 added skills as a first-class retrieval object behind **four** gateway tools — `search_tools`,
`invoke_tool`, `search_skills`, `invoke_skill` — plus a `relatedSkills` side-channel attached to the tool
results. Before that surface shipped (it was still in review, unpublished), three problems surfaced:

1. **Discovery reliability.** Skills only surfaced if the model chose to call `search_skills` (skippable) or
   if a tool happened to map to a skill via `relatedSkills`. The model often never looks.
2. **Top-K starvation risk.** Any attempt to rank tools and skills in one list lets the many, verbose tools
   crowd a needed skill out of the top-K; their BM25 scores aren't even comparable (tool text carries an
   input schema, skill text carries tags/triggers).
3. **The push case.** For pure code-writing with *no* MCP tool involved (e.g. "build me a dashboard" in a
   React repo), there is no tool search to ride on, and BM25 over the raw, lexically-sparse prompt misses.

## Decision

### Surface: three tools, one search call, two reserved buckets
- **`search_capabilities(query, topKTools?, topKSkills?)`** → `{ tools: { groups }, skills: [...] }`. One
  discovery call returns **two independently-ranked buckets**, each with its own top-K budget. Skills can
  never be starved by tools, and we never compare BM25 scores across the two text shapes.
- **`invoke_tool(toolId, args)`** — unchanged.
- **`get_skill_content(skillId)`** → `{ body }` — renamed from `invoke_skill` (skills are *read*, not
  executed). Registered only when the skill catalog is non-empty.
- **`relatedSkills` is removed.** The `skills` bucket subsumes it; in the gateway the model always searches
  before invoking, so a side-channel on invoke is redundant. This also deletes the conditional
  `{ result, relatedSkills }` invoke-wrapping.

Reliability rationale: the model *must* search to find a load-bearing tool, so bundling skills into that same
response means **the tool's necessity carries the skill** — far more reliable than a separate, skippable
skill search.

### Two skill-surfacing mechanisms, each owning a distinct case
- **Pull (`search_capabilities` skills bucket)** — tool-adjacent work; BM25 over the capability-shaped query
  is the right instrument.
- **Push (the `UserPromptSubmit` preload hook)** — no-tool work from a terse intent prompt. It uses a
  distinct methodology (below) and is the experimental, non-load-bearing path.

### Push-path ranking methodology
1. **Triggers.** Skills declare author-written task phrases (`triggers: [dashboard, login form]`), indexed
   alongside name/description/tags. The body and `stacks` are **not** indexed. Triggers bridge a sparse
   prompt to the skill — the single highest-leverage signal.
2. **Project context as a boost, not a query term.** Detected project stacks (from `package.json`,
   `pyproject.toml`, `Cargo.toml`, …) *boost* skills whose declared `stacks` match; the prompt still selects
   *which* skill. Context narrows, intent picks. This replaces the old approach of folding constant stack
   terms into the query, which drowned weak prompts.
3. **Clear-winner gate.** The push path fires only when the top skill clearly beats the runner-up; vague
   prompts and ties (several skills sharing one stack) fire nothing.
4. **Engine staged, benchmark-gated.** BM25 + triggers + boost + gate ships first; semantic embeddings or an
   LLM router are added only if the benchmark shows BM25 underperforms.

### Telemetry
Tool and skill activity stay distinguishable on the existing core-owned stream: the unified search emits
`gateway_search` (tool hits) and the skill bucket's own `skill_search`; `get_skill_content` emits
`skill_invoke`. No schema change; the funnel (offered → loaded) is derivable from these.

## Consequences

- One discovery call for the agent, with skills guaranteed a reserved slot — the headline starvation worry
  is gone by construction.
- A breaking change to the (unpublished) SDK gateway surface: tool ids, factory names, and result shapes
  change; ADR-0011's "separate tools" decision is reopened. Mitigated by emitting type-tagged trace events so
  telemetry consumers still separate the paths.
- Skill ranking gains `triggers` (indexed) and `stacks` (boost-only) on the core `Skill` type; both are
  optional at the SDK/loader boundary so existing skills load unchanged.
- The push path's quality is now a *measurable* target: a skill-retrieval benchmark (recall@K plus an
  over-fire rate on negative prompts) is the instrument that tunes thresholds and decides whether semantic
  layers are worth their cost. We do not ship the push path "blind."
- Rejected: a single merged tools+skills ranked list (reintroduces starvation + cross-type score
  incomparability); keeping `relatedSkills` (overlapping third mechanism).
