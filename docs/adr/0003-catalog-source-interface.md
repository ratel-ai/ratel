# 3. Catalog source: pluggable loader interface, auth and scope, sync semantics

Date: 2026-07-05

## Status

Accepted

Compacted 2026-07 from pre-compaction ADR-0019 (catalog source interface), ADR-0020 (source
auth and scope), and ADR-0021 (sync and storage), all 2026-07-05. The scope model it
originally carried is split out to [ADR-0010](0010-catalog-scope-model.md) (Proposed); the
loader interface, auth, and sync semantics recorded here are accepted.

## Context

An earlier plan scheduled a standalone `ratel-ai-server` binary as the rung between the
in-process library and the managed cloud. Specifying it made two things clear: under the
embedded-replica model the "server" is only a **source of the catalog** (it stores skill
definitions and answers a conditional GET; it does not run retrieval), and the managed cloud
already is exactly that source. A separate OSS server would be a second implementation of the
same thin contract, built ahead of any demonstrated self-hosted demand.

The cloud is also the reference and the anti-pattern for auth: its Bearer scheme is sound, but
it persisted a `key_plaintext` column (one table read leaks every live key) and has no
per-user scope dimension.

## Decision

**No standalone server now.** The catalog is populated through a pluggable **source / loader
interface** in the SDK. The managed cloud is the first source, shipped as `@ratel-ai/cloud`
(npm) and `ratel-ai-cloud` (PyPI). The library remains the single artifact. A standalone OSS
server is deferred until real self-hosted or air-gapped demand; when built, it is an
implementation of the already-published contract, not a new design.

### The source seam (embedded replica)

- The SDK's `ToolCatalog` / `SkillCatalog` gain a source seam: a catalog fills from native
  in-process registration (the floor) or from a **source loader** that pulls a published
  catalog and hydrates the local registries. Retrieval (`search_capabilities` /
  `invoke_tool` / `get_skill_content`) always runs locally over those registries.
- The seam the SDK ships is the **mutable-catalog surface**, not a loader framework: a
  loader pushes skills with `SkillCatalog.upsert` (returns the added-vs-replaced signal),
  drops them with `remove`, reads current state with `get`/`has`, and the host observes
  churn via `onChange` — the single staleness hook to re-emit `tools/list_changed` and
  re-read a cached `search_capabilities` description on an empty↔non-empty transition. A
  loader is any separate package that holds a catalog and drives it to mirror its source
  (the managed cloud, a DB, a local file/dir, git, a self-hosted endpoint); no formal
  loader lifecycle interface is prescribed until interchangeable loaders are wanted.
- Loader-specific source selection and config — e.g. the Cloud loader's `RATEL_URL` and
  bearer key — live in the loader package, not the SDK; the SDK stays source-agnostic.
  Application code still does not change
  ([ADR-0002](0002-product-split-engine-local-cloud.md)).

### The wire contract

[`protocol/`](../../protocol/README.md) is the normative catalog-source contract: pull-sync
`GET /v1/catalog` with ETag/304, the `CatalogSkillWire` shape (the wire projection of the
engine `Skill` struct, defined in [`protocol/v1`](../../protocol/v1/README.md)), Bearer auth,
the `?scope=` selector, and language-agnostic **conformance vectors** (fixture catalogs with
their expected ETag, scope-overlay cases, and `If-None-Match`/304 semantics) every source and
loader MUST pass (so the contract, not the single closed implementation, stays normative). v1
serves **skills
only**; a skill's `tools` are ids resolved against the **client-owned** tool registry, so an
id with no local definition behaves as unknown-tool at invoke time while the skill stays
searchable. The contract covers the commodity catalog rung only: the cloud's suggestion /
analytics / ranking surfaces are deliberately off-protocol (private) until opened by an
explicit decision; `@ratel-ai/cloud` is also the developer's tap into those.

### Auth and scope (networked sources only; the in-process library authenticates nothing)

- **Hash-only API keys.** Plaintext is `rtl_` + 24 random bytes, shown once at creation,
  never persisted. Stored: `key_hash` (SHA-256 hex, the indexed lookup) + a short non-secret
  prefix + metadata with soft revocation (`revoked_at`). Bare SHA-256 is correct for a
  192-bit random token; a lost key is rotated, not recovered. The cloud's `key_plaintext`
  column is not carried forward.
- **Wire contract:** `Authorization: Bearer <key>` on every `/v1` request; missing/unknown/
  revoked → `401`, key store unreachable → `503`; TLS required.
- **Scope.** The served catalog is **scoped**: a project Bearer key authorizes a project, and
  an optional `?scope=<subject>` selector picks a subject layer within it. The scope model —
  the `tenant → project → subject` hierarchy, the overlay semantics, and the
  confidential-isolation policy — is [ADR-0010](0010-catalog-scope-model.md) (Proposed); the
  wire mechanics of the `?scope=` selector are frozen in
  [`protocol/v1`](../../protocol/v1/README.md). The engine stays scope-blind; the source
  serves an already-scoped set.
- **Two credentials, never conflated:** the source API key (this contract) and upstream OAuth
  tokens (`~/.ratel/oauth/`, owned by ratel-local, used by locally-run `invoke_tool` to reach
  upstream MCP tools). The source never sees either side's other credential.

### Sync semantics and storage classes

| Data class | Source of truth | Syncs? | Owner |
|---|---|---|---|
| **Catalog** (skill definitions) | the source when `RATEL_URL` is set, else local disk | yes: one-directional pull, ETag-gated | cloud / file loader / future self-hosted source |
| **Secrets** (upstream OAuth, source keys) | local machine / the source, always | **never** | ratel-local (oauth); the source (its keys, hash-only) |
| **Config / host-wiring** | local machine, always | **never** | ratel-local, unchanged |

- Sync is conditional-GET, not a delta protocol. The ETag content projection
  (`{id, name, description, tags, tools, metadata, body}`, sorted by id, timestamps excluded)
  is frozen in `protocol/v1`; changing it is a v2.
- A running agent is a read-only catalog consumer. Authoring is a separate authenticated
  write path, deferred (PSKS-8, internal tracker), so there is no offline-write/merge class.
- Secrets-never-sync is enforced **structurally**: no wire shape has a field that can carry a
  token, and a test fails if a secret-typed field enters a wire payload.
- Offline: the client keeps the last-pulled catalog and runs degraded but functional;
  staleness is unbounded and should be surfaced. `RATEL_URL` unset is the permanent offline
  floor. Nothing moves off `~/.ratel/*`: config and oauth stay in ratel-local, so the pivot
  deletes the mass re-auth risk a server port would have carried.

### Deferred, explicitly

- Authoring / CRUD / publish, version CAS, tool definitions in the pull: PSKS-8.
- The standalone server (and any loopback-daemon source with a same-machine auth exception).
  Shared self-hosting and air-gapped deployments are genuinely unavailable until it ships;
  positioning must not claim the loader story covers them.

## Consequences

- One artifact, smaller surface: no server crate/binary/release unit to build or maintain.
- The road back is cheap for the skeleton, not the value: a future server that implements
  `protocol/v1` gets catalog serving; the cloud's differentiated surfaces stay private unless
  separately opened (the usage-ranking read model is the first candidate).
- A leaked key table yields no usable credential (hash-only storage).
- The only server-side implementer today is the closed cloud; the conformance vectors are
  what keep the contract from silently becoming whatever the cloud does.

## Rejected

- **Build the server now:** spends effort on the speculative tier and duplicates the contract
  the cloud already implements.
- **Private cloud API, no `protocol/`:** forecloses future sources; the published contract is
  the insurance policy for the catalog rung.
- **Bidirectional sync:** adds an offline-merge class and an upward path a secret could leak
  through; authoring is a separate explicit write path instead.
- **KDF-hashed keys / mTLS:** adds weight where a 192-bit random token needs none; a lost
  key is rotated, not brute-forced. (The scope-model alternatives — per-subject keys as the
  default, confidential isolation — are weighed in [ADR-0010](0010-catalog-scope-model.md).)
