# 12. First-class skills — unified capability search + two-path methodology

Date: 2026-06-09

## Status

Accepted

## Context

The gateway's wedge is tool selection: upstream MCP tools are ingested, BM25-ranked, and reached through a
small fixed set of gateway tools so the agent's context isn't flooded with every tool definition. We want
the same treatment for **skills** — Claude Code `SKILL.md` playbooks (frontmatter + a Markdown body).

A skill differs from a tool in two ways that shape the design: it is **read, not executed** (its body is the
payload), and it surfaces in two very different situations — *while using a tool* (tool-adjacent) and *while
writing code with no tool involved* (a terse intent prompt like "build me a dashboard"). Skills are also
**advisory**: a task still completes without the right skill, just at lower quality — so skill-surfacing
fails *silently* and must be made measurable, not assumed.

Skills do not flow through MCP (the host reads `SKILL.md` files directly), so to actually save tokens the
gateway must be the *sole* loader of the skills it manages.

## Decision

### Source: a Ratel-managed folder
Skills are sourced from a Ratel-managed folder (default `~/.ratel/skills/`) that the host does not
auto-scan, so the gateway is the only loader and the savings are real. (A CLI moves skills in/out of the
host's native skill directory.)

### Surface: three gateway tools, one search call, two reserved buckets
- **`search_capabilities(query, topKTools?, topKSkills?)`** → `{ tools: { groups }, skills: [...] }`. One
  discovery call returns **two independently-ranked buckets**, each with its own top-K budget. Skills can
  never be starved by a large number of matching tools, and we never compare BM25 scores across the two
  different text shapes (tool text carries an input schema; skill text carries tags). A matched skill also
  contributes its declared `tools` to the tools bucket (see *Skill data model* below), so the agent gets a
  playbook and the tools it calls in one turn.
- **`invoke_tool(toolId, args)`** — runs a tool.
- **`get_skill_content(skillId)`** → `{ body }` — loads a skill's instructions; registered only when the
  skill catalog is non-empty.

Reliability rationale: the agent *must* search to find a load-bearing tool, so bundling skills into that same
response means **the tool's necessity carries the skill** — far more reliable than a separate, skippable
skill-search tool.

### Two skill-surfacing mechanisms
- **Pull — the `search_capabilities` skills bucket.** Tool-adjacent work; BM25 over the capability-shaped
  query is the right instrument.
- **Push — a `UserPromptSubmit` preload hook.** No-tool work from a terse intent prompt. Distinct
  methodology (below); experimental and non-load-bearing.

### Skill data model
A `Skill` is `{ id, name, description, tags, tools, metadata, body }`. Three buckets carry everything beyond
identity and body, split by *how the system uses them* rather than by author intent:
- **`tags`** — indexed. Author-declared labels **and** task phrases ("frontend", "login form"); folded into
  the BM25 text so a terse intent prompt matches. (This subsumes the earlier separate `triggers` field —
  mechanically a trigger was just an indexed phrase, so it is a tag.)
- **`tools`** — a typed dependency edge, **not** indexed. The ids of tools the body's instructions call;
  the gateway surfaces them in the `search_capabilities` tools bucket (additive, deduped) so a matched skill
  carries its toolkit.
- **`metadata`** (`map<string, string[]>`) — free-form, **not** indexed. Non-query context for higher layers
  — e.g. `{"stacks": ["react"]}` for the push-path ranker to boost/filter by project context.

### What is indexed
A skill is ranked over `name`, `description`, and `tags`. `body` (dispatch payload), `tools` (a dependency
edge), and `metadata` (e.g. `stacks` — project context) are **not** indexed.

### Push-path ranking methodology
1. **Task-phrase tags** bridge a lexically-sparse prompt to the skill — the highest-leverage signal.
2. **Project context is a boost, not a query term.** Detected project stacks (`package.json`,
   `pyproject.toml`, `Cargo.toml`, …) *boost* skills whose declared `metadata["stacks"]` match; the prompt
   still selects *which* skill. Context narrows; intent picks.
3. **Clear-winner gate** — the push path fires only when the top skill clearly beats the runner-up; vague
   prompts and ties fire nothing.
4. **Engine staged, benchmark-gated** — BM25 + triggers + boost + gate ships first; semantic embeddings or an
   LLM router are added only if the retrieval benchmark shows BM25 underperforms.

### Telemetry
Tool and skill activity stay distinguishable on the core-owned stream: the unified search emits
`gateway_search` (tool hits) and the skill bucket's own `skill_search`; `get_skill_content` emits
`skill_invoke`. No schema change; the funnel (offered → loaded) is derivable.

## Consequences

- One discovery call for the agent, with skills guaranteed a reserved slot — starvation is impossible by
  construction.
- `Skill` carries `tags` (indexed), `tools` (a dependency edge surfaced at the gateway), and `metadata`
  (non-indexed context, e.g. `stacks`); all are optional at the SDK/loader boundary, so a minimal
  `{ id, name, description }` skill loads unchanged.
- The push path's quality is a *measurable* target: an offline retrieval benchmark (recall@K plus an
  over-fire rate on negative prompts) tunes thresholds and decides whether semantic layers are worth their
  cost. We do not ship the push path blind.
- Rejected: separate `search_tools` / `search_skills` tools (skills become skippable; result shapes diverge);
  a single merged tools+skills ranked list (reintroduces starvation + cross-type score incomparability); a
  `relatedSkills` side-channel on tool results (an overlapping third mechanism, subsumed by the skills
  bucket); folding constant project-stack terms into the push query (drowns weak prompts — replaced by the
  boost).
