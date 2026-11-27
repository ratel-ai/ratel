# 8. One required `ci-gate` check

## Status

Accepted

## Context

`main` needs one clear answer to "may this pull request merge?". Path filters skip the jobs a
change does not touch, and a skipped matrix job never emits its per-leg checks, so a ruleset
that requires each job waits on checks that never come.

## Decision

**One pre-merge workflow, one required check.** Every pre-merge job lives in
`.github/workflows/ci.yml`. A last job, `ci-gate`, `needs:` all of them and runs
with `always()` in its `if:`: a skipped or successful job passes, and only a failure or a
cancellation fails the gate. `ci-gate` is the only required status check for code on `main`.

- A new pre-merge job goes into `ci-gate`'s `needs:`, never into the ruleset.
- The PR title has its own required check, `pr-title` (`.github/workflows/pr-title.yml`). It
  reads only the title, runs on drafts and on `edited`, and `ci.yml` does neither.
- `scripts/ci-filters.mjs` skips the areas a pull request does not touch. A push to `main`, a
  `workflow_dispatch` run and any change to `ci.yml` run every job.
- A draft pull request runs nothing and posts no `ci-gate`. Marking it ready runs the
  pipeline. To check a draft, dispatch `ci.yml` on its branch.
- A newer push to `main` cancels the older run, and the gate of a cancelled push run does not run.
  The gate of a cancelled pull request or `workflow_dispatch` run still fails.
- `scripts/setup-branch-ruleset.sh` is the source of truth for the `main` ruleset: the two
  required checks, linear history, review and thread resolution, and one bypass actor, the
  `core-maintainers` team.

## Consequences

- The ruleset never changes when jobs change.
- A job that is not in `ci-gate`'s `needs:` does not block a merge. Review of `ci.yml`
  changes catches this.
- Drafts cost no CI time until someone asks for a run.
