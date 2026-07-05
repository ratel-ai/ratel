# 17. Relicense the kernel to Apache-2.0; MIT elsewhere

Date: 2026-07-04

## Status

Accepted

## Context

The product split (ADR-0014) turns one workspace into four products with independent
release cadences: the Rust **kernel** (`ratel-ai-core`), a **server** binary wrapping it,
the **SDKs** / **CLI** / **telemetry** helpers, and the closed **cloud**. A single
workspace-shared `license = "MIT"` field (`Cargo.toml`), one root `LICENSE.md`, and one MIT
badge repeated across every component covered all of this while it shipped lockstep. Splitting
the products is the moment to ask the licensing question per component instead of once for the
whole tree.

Two forces set the answer:

- **The kernel is the reusable asset others embed.** `ratel-ai-core` is the retrieval /
  context-engineering engine that every SDK links via FFI and that a self-hosted server or a
  third party would build on. For a library whose whole point is to be embedded, an explicit
  **patent grant** is worth more than the terseness of MIT: it removes a patent-troll vector
  and matches what serious downstream adopters (and their legal teams) expect from a Rust
  crate they will ship inside a product. Apache-2.0 is the permissive license that carries
  that grant.
- **Everything else is a thin surface over the kernel.** SDKs, CLI, telemetry helpers, and
  examples add no independently patentable engine; MIT's terseness is a feature there, and
  the ecosystems those packages live in (npm, PyPI) are MIT-dominant. There is no reason to
  pay Apache's `NOTICE`/header ceremony on packages that are glue.

The stance is deliberately **fully permissive**. Ratel is **not** adopting AGPL or a BSL-style
source-available anti-rehosting license anywhere — not on the kernel, and (see below) not on the
server. The value we defend is the managed cloud (catalog intelligence, analytics, operations),
not a license moat around the OSS server. Copyleft or source-available terms would tax the exact
embedded-and-self-host adoption gradient ADR-0014 is built to encourage, in exchange for guarding
a rehosting threat that is not real today.

Two facts make this cheap to do now:

- **The repo is MIT today**, so this is a **relicense of a single crate**, not a fresh grant
  across a mixed tree. Nothing here is more restrictive than MIT for any consumer.
- **We hold the copyright** (`Copyright (c) 2025 Agentified`). A sole copyright holder may
  relicense its own future versions at will; **already-published versions keep the terms they
  shipped under** (anyone who received `ratel-ai-core` under MIT keeps those MIT rights to that
  release forever). The relicense is prospective, applies from the next published version, and
  needs no contributor sign-off given current provenance.

Phase 0 exists to **record** decisions; it does not touch code paths or license files (that is
Phase 1's job, kept in a separate PR so docs stay accurate in the window between them). This ADR
is therefore a decision record with a named, deferred execution — not the relicense itself.

## Decision

**License by component, permissive throughout:**

| Component | License | Rationale |
|---|---|---|
| `ratel-ai-core` (kernel crate) | **Apache-2.0** | patent grant on the embedded engine |
| SDKs (`@ratel-ai/sdk`, `ratel-ai`, native crates) | **MIT** | thin FFI surface over the kernel; npm/PyPI norm |
| CLI (`@ratel-ai/cli`) | **MIT** | glue over the kernel/server |
| Telemetry helpers (`ratel-ai-telemetry`, `@ratel-ai/telemetry`) | **MIT** | thin `init()` sugar over the OTel SDK (ADR-0015) |
| Examples | **MIT** | copy-paste starters |
| **Server** (`ratel-ai-server`, `@ratel-ai/server`) | **MIT** | it is *another component*, not a moat |

The server defaults to MIT with the rest. It is treated as **just another component** in the
split, **not** as the thing a restrictive license would protect. We **revisit only if rehosting
becomes a real, demonstrated threat** — a competitor standing up a managed Ratel on our OSS
server and taking material revenue we would otherwise earn. Until that evidence exists, adding
AGPL/BSL friction to the server buys nothing and costs the self-host on-ramp. If the threat
materializes, a future ADR supersedes this clause; it is not pre-committed here.

**We do NOT adopt AGPL, SSPL, BSL, or any source-available / copyleft license anywhere in this
repo.** Fully permissive is the position of record.

**Phase 0 records this decision. Execution is deferred to Phase 1**, which will:

- Add `LICENSE-APACHE` and a `NOTICE` file for `ratel-ai-core` (Apache-2.0 requires both the
  license text and attribution notices to travel with the crate).
- **Break the workspace-shared `license` field** in `Cargo.toml` (currently
  `[workspace.package] license = "MIT"`, consumed via `license.workspace = true`) into
  **per-crate** `license` declarations, so the kernel can carry `Apache-2.0` while sibling
  crates stay `MIT`.
- Set each per-manifest `license` accordingly (crate `Cargo.toml`s, `package.json`s, the
  Python `pyproject.toml`s).
- Fix the `../../../LICENSE.md` relative links and MIT badges in the component READMEs so each
  points at the license text that actually governs that component.
- Update the license sections of `README.md` and `CONTRIBUTING.md` to state the split
  (Apache-2.0 kernel, MIT everywhere else) and its patent-grant rationale.

Until that Phase 1 PR lands, `LICENSE.md`, every badge, and every license field remain **MIT** and
must not be flipped by Phase 0 doc work.

## Consequences

- **The kernel gains an explicit patent grant.** From the first Apache-2.0 release of
  `ratel-ai-core`, downstream embedders get patent protection MIT never offered; the crate reads
  as production-ready to legal review. In exchange, the crate carries Apache's `NOTICE` and
  per-file-header ceremony that MIT does not require.
- **The dependency tree is mixed-license, and that is fine.** An MIT SDK depending on an
  Apache-2.0 kernel is a standard, compatible combination (Apache-2.0 is one-way compatible into
  more-permissive-consuming builds; MIT and Apache-2.0 coexist freely). Consumers of the SDKs are
  unaffected: nothing becomes more restrictive than it was under all-MIT.
- **The relicense is prospective and needs no contributor CLA today.** We relicense our own future
  versions as sole copyright holder; published MIT releases stay MIT. If external contribution
  provenance ever gets murky, that is a future inbound-licensing question, not a blocker for this
  outbound change.
- **The server carries no moat, by choice.** We accept that a third party may legally rehost the
  OSS server. The bet is that the managed cloud's catalog intelligence and analytics — not license
  friction — are what customers pay for. Reversing this later means an ADR that supersedes the
  server clause and a version bump under the new terms; earlier server releases keep MIT.
- **Execution risk is isolated to Phase 1.** Splitting the workspace `license` field, adding
  `LICENSE-APACHE`/`NOTICE`, and repointing every relative link is mechanical but touches many
  manifests at once; doing it in one Phase 1 PR (separate from this record) keeps the Phase 0 docs
  internally consistent while the change is in flight.

## Rejected

- **Keep everything MIT, including the kernel.** Zero churn, but forgoes the patent grant on the
  one component where embedders most want it. MIT's brevity is the right call for glue packages, not
  for the reusable engine third parties ship inside their products.
- **AGPL or BSL on the server (anti-rehosting).** Would let us defend against a hosted competitor
  by license, but taxes the self-host on-ramp the product split is built to widen, signals a
  source-available posture to a permissive-expecting audience, and guards a rehosting threat that is
  not real today. We defend value with the managed cloud, not a license moat — and keep the option to
  revisit *with evidence* rather than pre-committing.
- **Relicense the whole repo to Apache-2.0.** Uniform and patent-granted everywhere, but imposes
  Apache's `NOTICE`/header overhead on thin SDK/CLI/telemetry packages that gain nothing from it and
  live in MIT-dominant ecosystems. The patent grant earns its ceremony on the kernel and only there.
