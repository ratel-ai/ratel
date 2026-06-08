# 11. First-class skills — retrieval over a Ratel-managed folder

Date: 2026-06-08

## Status

Accepted

## Context

Ratel's wedge is tool selection: the gateway ingests upstream MCP tools, BM25-ranks them, and exposes
`search_tools` / `invoke_tool` so the agent's always-loaded tool list collapses to two entries. The roadmap
commits to extending the same treatment to **skills** — "register skills alongside tools, ranked by the
same algorithm, dispatched on demand."

A Claude Code skill is a directory: `SKILL.md` (YAML frontmatter `name` / `description` / optional `tags`,
plus a 5–15 KB Markdown body) and optional bundled `scripts/` and reference files. Claude Code loads every
skill's name + description into the system prompt at all times; the body loads only on invocation. With a
large skill library, that always-on metadata is the same token-pressure problem Ratel already solves for
tools.

The structural difference from tools: **skills do not flow through MCP.** Claude Code reads `SKILL.md` files
directly, so the MCP gateway never sees them. A retrieval gateway can only *save* tokens if the skills it
manages are not also loaded natively — otherwise the metadata double-loads.

Three postures were considered:

- **Retrieval gateway over a Ratel-managed folder** — Ratel is the sole loader for a dedicated directory the
  host does not auto-scan; skills become catalog entries served via search/invoke. Biggest, cleanest win;
  trades away native skill UX (auto-activation, `/skill-name`) for the managed set.
- **Offline optimizer / rewriter** — Ratel shrinks existing `SKILL.md` files in place (compact description,
  trim body). Keeps native loading, but only shaves descriptions rather than removing them from always-on
  context; smaller, fuzzier win.
- **Intercept native skills** — not possible without a host-level seam Ratel does not own.

## Decision

Add **skills as a first-class retrieval object**, sourced from a **Ratel-managed folder** (default
`~/.ratel/skills/`) that the host does not auto-scan, and dispatched through **dedicated gateway tools
`search_skills` / `invoke_skill`** rather than overloading the tool gateway.

In the core (`ratel-ai-core`):

- A parallel `Skill { id, name, description, tags, body }` type and `SkillRegistry`, mirroring `Tool` /
  `ToolRegistry`. A sibling type (not an overloaded `Tool`) keeps the tool path untouched and lets skill
  telemetry stand on its own.
- The BM25 engine and its tuning (`k1 = 0.9`, `b = 0.4`, ADR-0004) are shared via an internal
  `bm25_search` helper; both registries call it. The identifier-splitting indexer is reused.
- **The `body` is not indexed** — only `name`, `description`, and `tags` drive ranking. The body is the
  dispatch payload; indexing 15 KB of prose would drown the description's precise terms.
- New core-owned trace variants `SkillSearch` / `SkillChurn` / `SkillInvoke` (additive per ADR-0009).

## Consequences

- The savings claim stays clean and measurable, exactly as for tools: skills in the managed folder are not
  natively loaded, so their always-on metadata cost collapses to the two gateway tools; bodies are retrieved
  only when a query matches.
- Skills in the managed folder lose native auto-activation and `/skill-name` invocation — they are reached
  via `search_skills` / `invoke_skill`. Skills a user wants always-on stay in the native skill directories
  and are simply not managed by Ratel.
- Separate gateway tools (rather than folding skills into `search_tools`) keep result shapes and telemetry
  unambiguous, at the cost of one extra always-loaded gateway tool. The roadmap's "extend `search_tools`"
  framing is satisfied in spirit; a future ADR may unify them once atoms/molecules/organisms land.
- Rejected: the offline rewriter (smaller win, edits user files) and native interception (no host seam).
  The rewriter remains viable as a complementary follow-up for skills that stay native.
- Out of scope here: CLI management of the folder (`ratel skill add/import`), savings-widget accounting for
  skills, and body chunking/retrieval (v0.2 chat-management territory).
