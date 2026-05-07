# 8. Per-package CHANGELOGs, skill-curated, CI-gated

Date: 2026-05-07

## Status

Accepted

## Context

We publish four artifacts in lockstep — `ratel-ai-core` on crates.io and `@ratel-ai/sdk`, `@ratel-ai/mcp-server`, `@ratel-ai/cli` on npm. Until now, release notes lived only in GitHub's auto-generated release page. Consumers installing a single package from npm or crates.io had nowhere to read what changed in *their* package between two versions, and the repo carried no in-tree record either. Releases also pass through an RC phase (per the release workflow [feedback memory: RC-first, Trusted Publishers]); each RC ships independently, but at GA we want a single consolidated entry rather than a chain of `-rc.0`, `-rc.1`, `-rc.2`, `0.1.5` sections.

We considered three authoring modes:

- **Manual + CI gate** — highest signal but most friction; every release commit needs hand-written entries.
- **Pure script (git-cliff in CI)** — zero friction but ships whatever the commit log looks like, including drafts that need rewording.
- **git-cliff drafts curated via a `/changelog` Claude skill** — git-cliff routes commits to packages by path, the skill orchestrates the workflow and lets us edit before commit. Best balance of automation and quality.

We considered three CI gate strengths: block, warn-only, and none. Block is the only one that prevents the discipline from rotting.

## Decision

1. Each of the four published packages has a `CHANGELOG.md` in its package directory, formatted per [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
2. Entries are drafted by [git-cliff](https://git-cliff.org), configured at repo root in `cliff.toml`. Path scoping per package is supplied at invocation time via `--include-path`, not in the config.
3. Drafting and curation are orchestrated by a repo-local `/changelog` Claude skill at `.claude/skills/changelog/`. The skill reads the target version, runs `draft.sh` to get per-package drafts, branches on RC vs GA, lets us curate, then writes the four CHANGELOGs (without committing).
4. **GA-collapse rule**: when shipping a non-RC version `X.Y.Z`, the skill collapses every existing `## [X.Y.Z-rc.*]` section in each CHANGELOG into a single `## [X.Y.Z]` section, deduplicating entries within Added/Changed/Fixed subsections. RC sections do not survive into GA.
5. **CI gate**: `release.yml`'s `tag-version-check` job verifies each CHANGELOG contains a `## [<tag-version>]` heading and fails the workflow if any are missing — blocking `publish-npm`, `publish-crate`, and `github-release`.
6. The skill runs locally as part of release prep, not in CI. CI only enforces the gate.

## Consequences

- Every release commit must touch the four CHANGELOGs. The CI gate enforces this; forgetting blocks the release.
- Commit-prefix discipline (`feat(scope):` / `fix(scope):` / `refactor(scope):`) becomes load-bearing for draft quality. `cliff.toml` skips `docs:` / `chore:` / `ci:` / `release:` by default; commits that should appear in CHANGELOGs need a `feat`/`fix`/`refactor`/`perf` prefix.
- `cliff.toml` is now a versioned dependency for the release process. Changes to it should be deliberate and reviewed; the format directly drives published release notes.
- `git-cliff` is a new toolchain dependency for anyone preparing a release. The skill detects missing installs and points to install instructions; CI does not need git-cliff because it only validates presence of the version heading, not the content.
- The GA-collapse rule means RC entries are ephemeral: the canonical history is the GA section. Anyone reading a CHANGELOG only sees released versions, never RC chatter.
- Adding a fifth published package later is straightforward: add a row in `draft.sh`, a row in the CI gate, and a new `CHANGELOG.md`.
