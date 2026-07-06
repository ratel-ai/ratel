# 21. Catalog sync semantics and storage classes

Date: 2026-07-05

## Status

Proposed

## Context

[ADR-0019](0019-catalog-source-interface.md) makes the catalog come from a pluggable *source*
(the managed cloud now, a loader or self-hosted source later) and the client an embedded
replica. That leaves three questions this ADR settles: what is authoritative, what crosses the
wire, and where local state lives now that there is **no server taking anything over**.

The context that shaped it: `ratel-local` owns a three-scope config hierarchy
(`~/.ratel/config.json` + project + local, last-wins merge that preserves unknown top-level
keys), a secret OAuth store (`oauth/<name>.json`, dir `0700` / file `0600`, cross-process-locked,
atomic), a skills move-ledger (`skill-manifest.json`), and Ratel-managed skill payloads
(`skills/<name>/SKILL.md`). The earlier server plan would have ported these into a Rust server;
without a server, they simply stay where they are. Meanwhile the cloud proves a durable,
pull-based, ETag-gated catalog, alongside cloud-only tables (suggestions, intents, jobs, chat)
that no source needs to sync.

## Decision

### Three data classes, one owner and one sync rule each

| Data class | On disk today | Source of truth | Syncs over the wire? | Owned by |
|---|---|---|---|---|
| **Catalog** (skill definitions; tool defs deferred, PSKS-8) | `~/.ratel/skills/<name>/SKILL.md`; cloud `skills` table | the **source** when `RATEL_URL` set, else local disk | **Yes** — pull-sync, ETag-gated | cloud (closed) / a local file loader / a future self-hosted source |
| **Secrets** | `~/.ratel/oauth/<name>.json`; source API keys | **Local machine / the source, always** | **Never** | `ratel-local` (oauth); the source (its keys, hash-only) |
| **Config / host-wiring** | `~/.ratel/config.json` + scopes | **Local machine, always** | **Never** | `ratel-local`, unchanged |

This table is the ADR; the rest is its consequences.

### Source of truth and direction

A source is authoritative for the catalog **when, and only when, `RATEL_URL` is set**. With no
`RATEL_URL` the embedded-FFI path is the floor and local disk is the only truth — nothing to sync
against. Authority swaps at the `ToolCatalog` / `SkillCatalog` source seam
([ADR-0019](0019-catalog-source-interface.md)), exactly where a loader substitutes for native
registration.

Sync is **one-directional pull, source → client** — the cloud's proven model
(`GET /v1/catalog`). A running agent is a **read-only catalog consumer**: it pulls a published
set and never mutates source state by existing. Authoring (create / edit / publish / archive) is
a *separate, authenticated write path*, deferred to **PSKS-8** — deliberately not a side effect
of an agent running.

### What syncs vs what never syncs — enforced structurally

**Syncs:** the published skill set, projected to `CatalogSkillWire`
(`{id, name, description, tags, tools, metadata, body}`) — no timestamps, status, or version in
the content projection.

**Never syncs:** OAuth tokens (`access_token` / `refresh_token` / `code_verifier` /
`client_secret`), source API keys (stored hash-only; the cloud's `key_plaintext` column is not
ported — [ADR-0020](0020-catalog-source-auth-and-scope.md)), and config with inline secrets
(`headers.Authorization`, `analysis.extractor.apiKey`, `ServerEntry.clientSecret`).

The enforcement is **structural, not a policy check**: the sync path and the secret stores are
different modules with no shared code path, and no field of any wire shape *can* carry a token.
You cannot accidentally serialise what the type does not contain. A test fails loudly if a
secret-typed field ever enters a wire payload.

### Pull-sync / ETag

Conditional-GET, not a delta protocol. ETag = content hash over the resolved published set (for
the request's scope) projected to `{id, name, description, tags, tools, metadata, body}`, sorted
by id, timestamps/status/version excluded — so a byte-identical republish keeps the ETag stable.
The global (scope-absent) case answers from a stored per-project catalog-version value without
loading the set; the `200` path hashes the live set and self-heals the stored value on drift.
Normative detail lives in [`protocol/v1`](../../protocol/v1/README.md); the projection is frozen
there. Catalog sync is durable and cache-validated (losing it corrupts what the agent sees); the
trace/telemetry stream is best-effort and lossy (ADR-0009/0015) — two contracts, kept on separate
surfaces, never merged into one "sync."

### Storage ownership — nothing moves, so nothing re-auths

The pivot away from a server removes the hardest constraint outright: **because no Rust server
takes over `~/.ratel/*`, config and secrets stay in `ratel-local` exactly as today.** There is no
mass re-auth risk and no Rust port of the config/oauth readers to get byte-perfect — the files
never move.

Catalog storage, by owner:

- **Local catalog source:** a **file/dir loader** over the existing `~/.ratel/skills` layout (or
  a project directory). No new store, no migration — it reads the files `ratel-local` already
  manages.
- **Managed cloud:** owns its own catalog storage (Postgres today), closed. Its schema is its
  concern; it merely serves the published set over the wire contract.
- **Future self-hosted source:** would pick its own backend (SQLite by default, Postgres
  optional) when it is built — deferred with the server (ADR-0019), not a decision now.

Cloud-only tables (suggestions, conversations/messages/intents, query-intents, jobs,
events/trace-events) are never part of the sync. Remote telemetry is not a catalog table — it is
stock OTLP + Bearer into a separate receiver (ADR-0015).

### Offline

- Client keeps the last successfully-pulled catalog (with its ETag). Source unreachable ⇒ the
  agent runs against the **last-known catalog** — degraded but functional, never a hard failure.
  Stale-but-valid beats empty.
- `RATEL_URL` unset / embedded FFI is the permanent offline floor: local disk, no network.
- No offline writes to reconcile — pull is read-only and authoring is a separate path, so there
  is no merge/conflict class. Secrets are always local, so OAuth refresh works fully offline
  against reachable upstreams.

## Consequences

- **The Phase-5 mass-re-auth risk is gone by construction.** Config and OAuth secrets never leave
  `ratel-local`; there is no server rewriting `~/.ratel/*`, so no byte-compat port to get right.
  This is the single biggest simplification the pivot buys.
- **`key_plaintext` stays a permanently-dropped column and secrets-never-sync stays an
  invariant, not a default.** A future "reveal my key" or "sync my config to another machine"
  feature is where both erode; the structural defense (no field, no shared module) is backed by a
  test that fails if a secret enters a wire payload.
- **Offline staleness is unbounded.** An agent that never reconnects runs an arbitrarily old
  catalog; the pull timestamp should be surfaced (statusline / max-age warning) so staleness is
  visible rather than silent.
- **The ETag content projection is locked into the contract.** Changing what is hashed
  invalidates every client's cache — a breaking (v2) change — so it is pinned in `protocol/v1`
  with the cloud's exact projection, guaranteeing a mixed fleet (cloud + any loader) computes
  identical ETags.
- **A local file loader must read `~/.ratel/skills` fail-soft, matching `ratel-local`.** It is a
  reader of an existing layout, not a new writer; parity with the current loader is a test
  target, but the stakes are far lower than the abandoned full storage port.

## Rejected

- **Port `~/.ratel/*` into a Rust server / SQLite (the earlier server plan).** Moot now — there is
  no server — and it was the riskiest part of the old plan (a lossy migration of files that must
  stay byte-compatible). Not building the server deletes the risk instead of mitigating it.
- **Bidirectional sync (client pushes local skills up, source merges).** Adds an
  offline-write/merge class the cloud never built and a path where a secret could leak upward;
  breaks the read-only-consumer boundary. Authoring is a separate explicit write path instead
  (PSKS-8).
- **A custom delta/oplog sync protocol.** Full-set + ETag/304 is sufficient at real sizes and
  avoids cursor/tombstone/ordering machinery; a delta, if ever needed, is additive, not v1.
- **Fold catalog sync and telemetry into one endpoint/stream.** Opposite reliability contracts
  (durable vs best-effort); conflating them makes one wrong (ADR-0015).
