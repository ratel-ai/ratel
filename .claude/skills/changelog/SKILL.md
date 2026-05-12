---
name: changelog
description: Update per-package CHANGELOG.md files for a Ratel release. Drafts entries with git-cliff (scoped per package), lets you curate, then writes the three CHANGELOGs. Handles both RC entries and GA-graduation collapse (merging X.Y.Z-rc.* sections into a single X.Y.Z section). Invoke before tagging a release.
---

# /changelog

Updates the three published-package `CHANGELOG.md` files in preparation for a release. The CI gate in `.github/workflows/release.yml` will reject any tag whose CHANGELOGs don't contain the version being released, so this skill must run before `git tag`.

## Packages it touches

| Package | CHANGELOG path |
|---|---|
| `ratel-ai-core` | `src/core/lib/CHANGELOG.md` |
| `@ratel-ai/sdk` | `src/sdk/ts/CHANGELOG.md` |
| `@ratel-ai/cli` | `src/integrations/cli/CHANGELOG.md` |

`@ratel-ai/mcp-server` lives in [ratel-ai/ratel-mcp](https://github.com/ratel-ai/ratel-mcp) and maintains its own CHANGELOG there.

## Procedure

### 1. Read the target version

Read `src/sdk/ts/package.json` and extract `.version` — all three manifests are kept in lockstep (enforced by `release.yml`'s `tag-version-check` job). Call this `$TARGET`.

If the user supplies a different version explicitly, prefer that and warn them their working tree disagrees.

### 2. Determine the diff range

Run `git describe --tags --abbrev=0` to find the previous tag. Call this `$FROM`. The drafted entries cover `$FROM..HEAD`.

### 3. Generate drafts

Run `bash .claude/skills/changelog/draft.sh "$FROM"`. The script outputs three `### <package-name>` blocks, each containing either Keep-a-Changelog-style sections (`### Added`, `### Fixed`, `### Changed`) or a single line `_No package-specific changes; released in lockstep with workspace._`.

If `draft.sh` exits 127, git-cliff is missing. Tell the user how to install it (the script's stderr already does), and stop.

### 4. Branch on RC vs GA

Inspect `$TARGET`:

- **RC** (`X.Y.Z-rc.N`): for each CHANGELOG, prepend a new section above the most recent versioned section:
  ```
  ## [X.Y.Z-rc.N] - YYYY-MM-DD
  
  <draft content for that package, or the lockstep-only sentinel>
  ```
  Use today's date in `YYYY-MM-DD` (UTC).

- **GA** (no `-rc` suffix): enter **GA-collapse mode**. For each CHANGELOG:
  1. Find every `## [X.Y.Z-rc.*]` section already present that matches the same `MAJOR.MINOR.PATCH` as `$TARGET`.
  2. Union their bullet entries (per Keep-a-Changelog subsection: `### Added`, `### Changed`, `### Fixed`) with the new draft entries from step 3 (covering commits since the last RC tag).
  3. Deduplicate bullets within each subsection (case-insensitive, whitespace-normalised).
  4. Drop the `_No package-specific changes_` sentinel if any real entries exist; keep it only if the unioned set is empty.
  5. Replace all the matched RC sections with a single `## [X.Y.Z] - YYYY-MM-DD` section containing the merged content.
  6. Leave non-matching prior versions (e.g. `## [0.1.4]`) untouched.

### 5. Curate with the user

Show each CHANGELOG's pending changes in the conversation. Ask the user to confirm or edit. Common curation moves:

- Rephrase bullets for user-facing clarity (the draft uses commit subjects verbatim).
- Drop bullets that are not user-visible (internal refactors that slipped past `cliff.toml`'s skip rules).
- Merge duplicates that survived deduplication.
- Promote / demote between Added / Changed / Fixed if the commit prefix was wrong.

### 6. Write the files

Once approved, write the three CHANGELOGs using the Edit tool. **Do not commit.** The release commit is the user's responsibility — they typically include the CHANGELOGs alongside the version bumps in a single `release: vX.Y.Z` commit.

### 7. Remind

Tell the user:

- The 3 CHANGELOGs are staged in the working tree (unstaged).
- Next step is the release commit + tag + push.
- The `release.yml` `tag-version-check` job verifies the CHANGELOGs contain the tag version; if any don't, the release is blocked.

## Conventions

- **Date format**: `YYYY-MM-DD` in UTC.
- **Subsection order**: `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Deprecated`, `### Security`. Omit empty subsections.
- **Sentinel**: `_No package-specific changes; released in lockstep with workspace._` for releases where a package has no in-scope commits.
- **Keep `## [Unreleased]` at the top** — it stays empty between releases.

## Why this exists

ADR 0008 (`docs/adr/0008-per-package-changelogs.md`) records the decision and rationale. Read it if you're unsure why something is structured the way it is.
