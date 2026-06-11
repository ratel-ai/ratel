# 12. Staged, resumable release pipeline

Date: 2026-06-11

## Status

Proposed

## Context

A Ratel release publishes one version to three immutable registries from a
single source tree: `ratel-ai-core` (crates.io), `@ratel-ai/sdk` + its five
per-OS native packages + `@ratel-ai/cli` (npm), and `ratel-ai` (PyPI). The
versions move in lockstep (ADR-0008): one number, enforced by a CI gate.

The current `release.yml` fires on a `v*` tag and runs `publish-npm`,
`publish-crate`, and `publish-pypi` as **independent, parallel jobs**. Two
properties of that design make a failure expensive:

1. **It is not atomic across registries.** If npm succeeds but PyPI fails (a
   transient registry error, a runner dying), version `X.Y.Z` exists on some
   registries and not others. No registry permits republishing a version, so the
   only way forward is to abandon `X.Y.Z` and ship `X.Y.Z+1` — which breaks the
   lockstep invariant the whole release model depends on.
2. **The npm and crate publishes are not idempotent.** Only the PyPI step has
   `skip-existing`. A partial npm publish (say 3 of 7 packages) cannot be
   re-run on the same tag — `npm publish` rejects the 3 that already landed — so
   the same version-burning skew results.

There is no way to make writes to three independent immutable registries truly
atomic. But the blast radius can be shrunk to near zero: build and validate
*everything* before any registry write, then make every write idempotent so a
re-run finishes the same version instead of burning it. This is the pattern
`cargo-dist` and `goreleaser` converge on (plan → build → host → publish →
announce). Notably, `scripts/publish-rc.sh` already implements the idempotent,
dependency-ordered, resumable publish logic — but only on the laptop-bootstrap
path, never in CI.

## Decision

Introduce `release-staged.yml`: a release pipeline structured as ordered phases
rather than parallel publishes.

1. **preflight** — version/CHANGELOG sync, `cargo publish --dry-run`, and a check
   that the CLI tarball rewrites its `workspace:^` dependency. No network writes.
2. **build** — the five native binaries (npm) and five wheels + sdist (PyPI),
   using the same matrix steps as `release.yml`.
3. **stage** — pack all seven npm tarballs, run `twine check`, assert every
   artifact is present, and park the binaries/wheels/sdist in a **draft** GitHub
   Release (a private, discardable staging buffer). No registry writes.
4. **publish** — the only phase that writes to a registry, in dependency order
   (crate → native subpackages → loader → PyPI → CLI). Every step first checks
   the registry and skips anything already at this version, and treats a
   "previously published" rejection as success. A re-run after a partial failure
   therefore **completes the same version**. This ports `publish-rc.sh`'s logic.
5. **verify** — install the published packages from the live registries on all
   five platforms with no toolchain present (reuses `verify-install.yml` via
   `workflow_call`). Gates the announce.
6. **announce** — flip the draft Release public.

It is introduced as a **separate, `workflow_dispatch`-only workflow that defaults
to a no-publish rehearsal** (`confirm_publish=false`: build + stage + validate,
write nothing, create no release). It does not trigger on tags, so it cannot
collide with `release.yml` during the trial period. Cutover — repointing the
`v*` trigger at this workflow and retiring the parallel publishes in
`release.yml` — is a deliberate follow-up once it has been exercised in rehearsal
and on a real `-rc` release.

## Consequences

- A partial or failed release stops being a permanent, version-burning event and
  becomes a safe **re-run** that finishes the same version. This is the primary
  goal.
- Releases become more serial and therefore slower in wall-clock time (the
  five-platform verify gate in particular runs before announce). Safety is bought
  with time; for a lockstep release across three immutable registries this is the
  intended trade.
- The release "go-live" moment is the single near-atomic undraft of the GitHub
  Release, reached only after every registry published and every platform
  verified — instead of three jobs racing to publish independently.
- The operator flow changes for this workflow: rather than pushing a `v*` tag,
  you dispatch the workflow with a version; it creates the tag + draft Release and
  undrafts on success. A rehearsal (the default) creates neither.
- `verify-install.yml` gains a `workflow_call` trigger (additive; its existing
  manual and daily-cron behavior is unchanged).
- This ADR does not change the lockstep versioning model (ADR-0008), what is
  published, or how users install. It changes only *how* the release is executed.
- **OIDC trusted publishing is bound to the workflow filename.** The existing
  Trusted Publisher relationships on npm (7 packages), crates.io, and PyPI all
  point at `release.yml`. A *real* publish from `release-staged.yml` will fail
  authentication until either (a) `release-staged.yml` is added as an additional
  Trusted Publisher on each registry entry, or (b) cutover replaces `release.yml`'s
  contents with this pipeline so the authorized filename is preserved. The default
  rehearsal (`confirm_publish=false`) publishes nothing and needs no registry-side
  change — so it can be exercised immediately.
- `RELEASING.md` predates the Python SDK and still documents only npm + crates.io;
  it should be refreshed alongside cutover. Until cutover, `release.yml` remains
  the production release path.
