# 29. Ratel Platform: two editions, Cloud modules in a private repository checked out at `ee/src`

Date: 2026-10-23

## Status

Proposed

Amends the repo-boundary rule of [ADR-0002](0002-product-split-engine-local-cloud.md) with one
exception (the Cloud modules share source with the core rather than a protocol). Consistent with
[ADR-0009](0009-licensing.md): no proprietary code enters this repository. Alternative to the
one-repository option recorded on branch `feat/ratel-platform`; one of the two is accepted, the
other dropped.

## Context

Ratel Cloud and a self-hostable Ratel OSS are to run on one core: the same application, the same
design system, one build. The editions differ in identity, workspaces, billing, admin and support,
which Cloud has and OSS does not. Two copies of the application would drift from the first day;
the core has to stay unaware of which edition it is running as.

Two further requirements: the Cloud code stays private, and this repository stays canonical — an
outside contributor clones, installs, tests and opens a pull request with no extra step.
Together they rule out a single repository: either the Cloud code is public, or the public
repository is a generated mirror of a private one (GitLab's model), which contributors cannot
work against directly.

## Decision

**One application, two compositions.** `apps/web` (`@ratel/platform`) holds the core. Every
capability that differs by edition is a port declared in `apps/web/lib/contracts/`, with an OSS
implementation in `apps/web/lib/adapters/oss/`. A composition root reads `RATEL_COMPOSITION`
(`oss` or `cloud`; unset means `oss`), mounts one set of implementations, and exits the process
at startup if the set is incomplete — never "ready" and then failing on every request.

**The Cloud modules live in a private repository, `ratel-ai/ratel-platform-ee`, checked out at
`ee/src`** — Mattermost's topology. `ee/src` is ignored by git here. `ee/package.json` stays
public, so the lockfile and `pnpm install --frozen-lockfile` are identical with and without the
checkout. The checkout is a plain clone, not a submodule: a submodule would put a pointer-bump
commit here for every Cloud change and publish private commit hashes.

**Routes are copied, not committed.** The private repository holds one-line route stubs in
`routes/`. `scripts/link-ee.mjs --auto` runs before `dev`, `build` and `typecheck`: it copies them
to `apps/web/app/(ee)/` (ignored by git) when `ee/src` exists, and removes them when it does not.
Copied rather than symlinked, because Turbopack rejects symlinks leaving the project root and
`next dev` does not discover routes behind a symlink. With the checkout absent, every command
builds Ratel OSS; nobody runs a step to get the right tree.

**One boundary rule, checked mechanically** by `scripts/check-ee-boundary.mjs`, here and in the
private repository's CI: nothing outside `ee/` imports from `ee/` (except the copied route stubs),
and `ee/src` imports only `@/lib/contracts/*`, itself, and npm packages.

**One Dockerfile, two targets** (`oss`, `cloud`). The Cloud adapters are reached through one
build-time alias, `#ee-composition`, resolved to `ee/src/composition.ts` for Cloud and to an
empty stub otherwise. The OSS target never copies `ee/`; the Cloud target builds where the
checkout exists, and fails without it rather than producing an OSS image under the Cloud name.

**Paired CI** (to build): the private repository's CI checks out the public branch of the same
name, falling back to `main`, and a nightly job builds Cloud against the public `main`.

## Consequences

- Contributors never see or need the Cloud code. The public repository builds, tests and ships
  Ratel OSS alone.
- A Cloud developer works in one tree, with one dev server: typecheck, lint and tests cover both
  sides locally, and edits under `ee/src` reload live.
- A change that touches core and Cloud is two pull requests, merged public first. The private
  `main` can break between the two merges, and a public change from an outside contributor is not
  checked against Cloud until CI does it. Mitigated by paired CI and by additive contract changes;
  this is the standing cost of the decision.
- Copied route stubs outlive the checkout unless every entry point resynchronises them, which is
  why `typecheck` runs `link-ee.mjs` as `dev` and `build` do.
- The OSS image contains no Cloud code by construction; the image check still searches for
  strings unique to a Cloud page and a Cloud adapter, with the Cloud image as the control.

## Rejected

- **One repository with `ee/` under a commercial licence** (Langfuse, Metabase). Makes the Cloud
  code public.
- **A private canonical repository with a generated public mirror** (GitLab). Contributors would
  work against a mirror.
- **A git submodule at `ee/src`.** A public commit for every Cloud change, and private hashes
  published.
- **Package shells with a symlinked `src`** (Novu). Turbopack resolves the symlink to its real
  path and never sees the shell's dependencies.
- **Symlinked route directories.** Work in `next build`, return 404 in `next dev`.
