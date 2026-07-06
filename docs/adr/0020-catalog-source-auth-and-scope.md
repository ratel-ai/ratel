# 20. Catalog source authentication and scope

Date: 2026-07-05

## Status

Proposed

## Context

A **networked catalog source** — the managed cloud today, a self-hosted source later
([ADR-0019](0019-catalog-source-interface.md)) — needs a front-door credential (how a client
or loader authenticates *to* the source) and a way to decide *which* catalog a request sees.
The in-process library needs neither: it has no network and reads local disk. This ADR fixes
auth and scope for the networked case; [ADR-0019](0019-catalog-source-interface.md) fixes the
sync shape it rides on.

The closed cloud app is the reference and the anti-pattern. Its Bearer path is sound —
`Authorization: Bearer <key>` → `sha256(key)` → `WHERE key_hash = $ AND revoked_at IS NULL` →
a `projectId`. But despite a docstring claiming "only the SHA-256 hash is stored," a migration
(`0002_busy_squirrel.sql`) added a `key_plaintext` column, both key-creation call sites persist
it, and the settings page reads it back to re-reveal keys — one read of that table leaks every
live key. The cloud also has **no per-user scope**: auth resolves to a project only,
`end_user_id` is an opaque analytics attribute on rows (never an auth principal), and the sync
endpoint is hard-wired global-only (`end_user_id IS NULL`).

The task requires: never import the plaintext-key pattern; design per-user scoping fresh; and
keep this credential distinct from the upstream OAuth tokens (`~/.ratel/oauth/<name>.json`) the
kernel uses to reach *upstream* MCP tools, which are a separate secret store owned by
`ratel-local` per [ADR-0010](0010-extract-mcp-server-to-ratel-mcp.md) and never sync.

## Decision

### Two credentials, never conflated

1. **Source API key** — client / loader → catalog source. The credential this ADR designs.
2. **Upstream OAuth** (`~/.ratel/oauth/<name>.json`) — used during a *locally-run*
   `invoke_tool` to reach an upstream MCP tool. A separate secret store, owned by
   `ratel-local`, that **never syncs** (ADR-0010, [ADR-0021](0021-catalog-sync-and-storage.md)).
   This ADR only draws the boundary: the source never asks the client for an upstream token and
   never forwards the client's source key upstream.

### Hash-only API keys

Keep the cloud's generator and lookup; drop its plaintext column.

- Plaintext is `rtl_` + `randomBytes(24)` base64url, returned in the creation response **once**
  and never persisted.
- Stored columns: `key_hash` (SHA-256 hex, unique index — the lookup key) + `key_prefix`
  (first ~12 chars, non-secret, for human recognition) + metadata (`id`, `name`, `created_at`,
  `last_used_at`, `revoked_at`, scope). **The `key_plaintext` column is not ported.** There is
  no reveal-later endpoint; a lost key is *rotated*, not recovered.
- Lookup: `sha256(key)` → `WHERE key_hash = $ AND revoked_at IS NULL`. Bare SHA-256 is correct
  here — the input is 192 bits of randomness, not a guessable password, so a slow KDF buys
  nothing and would forfeit the O(1) indexed lookup. No plaintext-compare path ever exists.
- Revocation is soft (`revoked_at` stamp, row retained) so audit survives; the
  `revoked_at IS NULL` predicate is the single enforcement point. `last_used_at` updates are
  best-effort, async, coalesced — never on the request's critical path (ADR-0009 query-log
  semantics).

Where keys live is the source's concern: the managed cloud stores them (closed, hash-only); a
future self-hosted source stores them hash-only the same way. There is no local key store today
because there is no local server — the in-process library authenticates nothing.

### Wire format and status contract

`Authorization: Bearer <key>` on every request to a networked source. Missing/malformed →
`401`; unknown/revoked → `401`; key store unreachable → `503`. The key is opaque to the client
(the `rtl_` shape is source-internal). A networked source MUST be served over TLS — a bearer key
is a replayable static secret.

### Scope model — designed fresh: `tenant → project → subject`

We keep the cloud's two structural levels and promote the missing third to a first-class
dimension:

- **tenant** — the cloud's `account`, renamed deployment-neutral (a self-hosted org and a single
  dev are also tenants). Isolation / ownership root.
- **project** — the catalog namespace; carries the catalog-version (ETag) value.
- **subject** — the per-user dimension: the end-user the agent acts on behalf of, i.e. the value
  the SDK already emits as `end_user_id`. New here: it can be a resolved scope on a request, not
  only a data attribute.

**How a request carries scope.** A **project Bearer key** authorises `{tenant, project}`. A
**`?scope=<subject>` query parameter** selects the subject layer within that project. The
`scope` selector is *not itself authenticated*: a project key may address any subject in its
project. That is the right default for the dominant shape — one backend holds one Ratel key and
serves thousands of its own end-users — and it matches how the cloud's project key works today.
Absent `scope` ⇒ the global layer only, byte-compatible with a source that has no subjects.

**What the client sees.** Served catalog = the subject layer overlaid on the global layer,
subject-wins on name collision; names stay unique project-wide. With no subject the union
degenerates to the global set, so a scope-unaware client behaves exactly as today. The kernel
stays scope-blind: the source resolves the scope, selects rows, and serves an already-scoped
set.

**Confidential per-subject isolation** (users must not see each other's subject catalogs) is a
deployment *policy*, reserved and addable without a wire change: a deployment binds a key to a
subject and rejects a mismatching `?scope`. The selector is always permitted; a policy simply
constrains it.

### In-process and single-user

The in-process library has no network and no auth. A single developer using only the library,
or `ratel-local` reading local disk, presents no key — there is nothing to authenticate against.
Scope collapses to the global layer by construction. Per-user scoping only materialises where a
networked source serves more than one principal. *(A future local-daemon source, if one is ever
built, may bind loopback and skip auth for same-machine clients — deferred with the server
itself.)*

## Consequences

- **A leaked key table yields no usable credential** — every stored value is a hash. The
  "reveal my key" feature that reintroduced `key_plaintext` in the cloud is impossible by
  construction; rotation is the recovery path, stated as a hard invariant.
- **The scope selector is a project-level confidentiality boundary, not a per-subject one.** A
  broad or leaked project key can read any subject's catalog in its project — correct for
  backend-serves-many-users, and to be called out; genuine multi-user confidentiality uses the
  reserved key-bound-subject policy.
- **App code never changes between tiers.** The Bearer scheme is identical whether the source is
  the cloud or a future self-hosted one; only the endpoint and the number of distinct scopes
  differ (ADR-0014).
- **One resolver serves every networked source.** `authenticate(req) → {tenant, project,
  subject}` and a single scoped catalog read cover cloud and any future self-hosted source; only
  storage and scope cardinality vary.

## Rejected

- **Port the cloud's `key_plaintext` (a reveal-key feature).** The exact anti-pattern the task
  forbids; turns the key table into a plaintext dump.
- **Argon2/bcrypt or an HMAC pepper for the key hash.** Slow KDFs and peppers defend low-entropy
  secrets; a 192-bit random token needs neither, and a pepper is itself a non-syncing secret to
  manage. Bare SHA-256 keeps the indexed lookup and is sufficient.
- **Per-subject keys as the default (subject encoded in the key, no selector).** Strong
  isolation, but it breaks the one-backend-serves-many-users shape and diverges from the
  project-key model real installs use. Offered instead as the opt-in confidential mode.
- **Port the cloud's `account → project → key` verbatim (no per-user scope).** Zero risk but
  forecloses the per-user catalogs this direction exists to enable; sync would stay hard-wired
  global-only.
- **mTLS / client certs as the default.** Strong, but heavy for the loader and single-user tiers,
  can't be expressed as a simple `RATEL_URL` string, and diverges from the OTLP + Bearer
  telemetry path. A possible opt-in for hardened self-hosted, not the default.
