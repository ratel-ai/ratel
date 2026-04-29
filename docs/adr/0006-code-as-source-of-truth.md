# 6. Catalog/config ownership: code as source of truth

Date: 2026-04-29

## Status

Accepted

## Context

Tools, MCPs, and auth configurations have to be declared somewhere. Two competing patterns exist in the gateway tier we're displacing:

- **Server-as-source-of-truth.** Ops register tools/MCPs through a UI or admin API; agent code reads from the server.
- **Code-as-source-of-truth.** Developers declare tools/MCPs in code (or YAML alongside it); the lib reflects them to the server on startup.

The first pattern duplicates configuration across two surfaces (code and server-side admin); keeping them in sync is its own ongoing chore. The second matches how modern infrastructure tooling works — Terraform state, Datadog monitors-as-code, K8s manifests-and-controllers — and is the path of least resistance for the developers we want to move fast.

See `docs/RATEL_V1_PLAN.md` §4.4.

## Decision

Code is the source of truth for tool, MCP, and auth declarations. The lib upserts them to the server on startup using stable IDs. Conflicts default to "code wins."

The server is **additive**: ops can layer on tools that weren't declared in any single agent's code (e.g., "all our agents now have access to the new internal-search MCP"), and the lib pulls catalog state on startup and merges with local declarations. There is **no separate registration step** — developers don't touch a UI or admin API before deploying.

## Consequences

- Single config surface for developers — what's in code is what runs.
- The server's "catalog augmentation" surface is an *ops* concern (different audience, different UX) rather than a *developer* concern. Ops tooling for catalog augmentation lands in Phase 3 (server) or Phase 4 (CLI).
- Stable IDs for tools/MCPs/auth declarations are load-bearing. Renaming is a coordinated migration, not a free rename.
- The "code wins on conflicts" default may need an override mechanism for ops-only fields (e.g., per-tenant policy) in later phases; v1 keeps it strict.
