# 14. Cloud skill-catalog sync and suggestion review via `@ratel-ai/cloud`

Date: 2026-07-01

## Status

Accepted

Extends [ADR-0012](0012-first-class-skills.md) (data model, gateway surface, and two-path methodology
stand; this ADR adds a second skill *source* beside the managed folder and relaxes one registration note).

## Context

Ratel Cloud is now the durable home of a project's skill catalog: `GET /api/v1/catalog` serves the
published set with standard ETag/`If-None-Match` semantics, authenticated by the per-project API key, in
a wire shape that matches the SDK `Skill` field-for-field. Cloud's self-improvement engine produces skill
suggestions (edit/new) that are either auto-applied to the published catalog or held for approval.

The SDK cannot consume any of this today:

- `SkillRegistry` is **append-only** — `register` is a blind push (duplicate ids possible), there is no
  remove/update, and `ChurnKind::Remove` has never been emitted. A re-synced catalog cannot be applied to
  a running process.
- `search_capabilities` snapshots `hasSkills` at construction, so a catalog populated after tool
  construction never advertises skills.
- With only the project API key, suggestion review is reachable solely through Cloud's MCP endpoint; the
  REST routes require a dashboard session.

The product decision (Cloud refactor plan) is **pull/cache**, not a live connection-string adapter: the
SDK downloads the catalog once per session and re-syncs periodically.

## Decision

### Core: granular mutation on `SkillRegistry` only

`upsert(skill) -> bool` (in-place replace at the same index, preserving deterministic tie-break order;
normalizes historical duplicates) and `remove(id) -> bool` (removes all occurrences). Churn: upsert-new
emits `Add`; upsert-existing emits `Remove` then `Add`; `remove` emits `Remove` only when something was
removed. No new `ChurnKind` — trace consumers don't need to learn "update". Rejected: `replace_all` with
internal diffing (ownership policy doesn't belong in core, and the SDK would re-ship host-local skills
across FFI every resync). `ToolRegistry` deliberately unchanged: no remote tool-sync driver exists.

### Sync: pull/cache in a pure-TS `@ratel-ai/cloud` package

New workspace package (`src/sdk/cloud`, `@ratel-ai/sdk` as peer dependency, zero HTTP deps). One
`CloudClient({ baseUrl?, apiKey? })` with env defaults (`RATEL_CLOUD_URL` / `RATEL_CLOUD_API_KEY`) fronts
everything: the trace exporter (ADR-0013), `fetchCatalog(etag?)`, `syncSkills(catalog, opts)`, the
suggestions client, and `reportRunMetrics`. Conditional GET with ETag; in-memory cache only in v1 — an
offline start yields no cloud skills until the first successful resync (no disk cache).

**Ownership rule:** the sync handle tracks the set of ids *it* registered. Within that set, Cloud is the
source of truth (field-wise equality gate so idempotent resyncs emit zero churn; missing-from-wire means
remove). A wire id colliding with a host-registered skill is **never clobbered** — it is reported as a
conflict and stays host-owned. Host-local skills are structurally untouchable.

### Gateway: dynamic skill advertising

`search_capabilities` computes its description at read time from the live catalog. `SkillCatalog` gains
an `onChange` hook as the staleness signal for MCP hosts (`notifications/tools/list_changed` wiring lives
in the ratel-mcp repo — a follow-up, not this change). ADR-0012's "`get_skill_content` registered only
when the catalog is non-empty" note is relaxed for sync-wired hosts: register it up front, even against
an initially empty catalog; it already answers unknown ids structurally.

### Suggestions: thin project-key REST, wrapped as typed methods

Cloud adds `GET/POST /api/v1/suggestions[...]` routes (list/get/approve/reject/generate) that reuse the
existing `AgentCapabilities` layer and Bearer plumbing — no new business logic. The SDK wraps them as
typed methods. Rejected: driving Cloud's MCP endpoint from inside the SDK (an SDK client parsing
tool-call payloads instead of typed JSON) and auto-refreshing the catalog after an approve (the
approve-then-`refresh()` pattern stays explicit). Auto-applied suggestions need nothing: they land in the
published catalog and arrive through normal re-sync.

## Consequences

- A running agent picks up approved/auto-applied skills without a restart; BM25 rebuilds per query, so a
  mutation is visible on the next search with no index invalidation step.
- Churn telemetry becomes an honest add/remove ledger of the synced catalog, composing with
  `catalog_version` stamping (ADR-0013) via a version-change hook on the sync handle.
- MCP-connected clients keep a stale `tools/list` description until ratel-mcp wires `list_changed` off
  `onChange`; direct SDK hosts get the full fix now.
- The suggestions REST contract is mirrored by the SDK's mock server; drift between the two repos
  surfaces in the SDK's e2e, not in production.
- TS-first: the Python SDK gets the mutation surface (parity), not the cloud client; a Python
  `ratel-ai[cloud]` is deferred.
