# proof/phase-1: Phase 1 pull requests and their merge order

Plan "Ratel consolidation", decision land-phase1-first: every Phase 1 change merges into ratel and ratel-platform `main` before the apps/web to src/ move (RP-34). All PRs are drafts. A human merges them, in this order. ratel merges first.

| # | Repo | PR | Branch | What | Proof |
|---|---|---|---|---|---|
| 1 | ratel | [#376](https://github.com/ratel-ai/ratel/pull/376) | `fix/refuse-foreign-project-evals` | RC-853 / RP-10: refuse evals from another organization's project | [proof/rp-10](https://github.com/ratel-ai/ratel/tree/proof/rp-10) |
| 2 | ratel | [#377](https://github.com/ratel-ai/ratel/pull/377) | `feat/simplify-admin` | RP-22: drop the operator Quality console and its EditionUi slot (twin of ratel-platform #116) | [proof/rp-21](https://github.com/ratel-ai/ratel/tree/proof/rp-21) |
| 3 | ratel | [#378](https://github.com/ratel-ai/ratel/pull/378) | `beluga/rp-12-manage-cloud-feature` | RP-13, RP-14, RP-63: flags port | [proof/rp-12](https://github.com/ratel-ai/ratel/tree/proof/rp-12) |
| 4 | ratel | [#379](https://github.com/ratel-ai/ratel/pull/379) | `beluga/rp-17-port-ratel-cloud-s` | RP-15 to RP-18, RP-81, RP-82: ratel-cloud ports | [proof/rp-15](https://github.com/ratel-ai/ratel/tree/proof/rp-15) |
| 5 | ratel | [#380](https://github.com/ratel-ai/ratel/pull/380) | `beluga/rp-25-ship-better-agents` | RP-27, RP-28, RP-83: Agents and MCP servers pages. Stacked on 3 and 4 | [proof/rp-25](https://github.com/ratel-ai/ratel/tree/proof/rp-25) |
| 6 | ratel-platform | [#116](https://github.com/ratel-ai/ratel-platform/pull/116) | `feat/simplify-admin` | RP-21 to RP-24, RP-74: admin fix and simplify, admin MCP server | [proof/rp-21](https://github.com/ratel-ai/ratel-platform/tree/proof/rp-21) |
| 7 | ratel-platform | [#115](https://github.com/ratel-ai/ratel-platform/pull/115) | `beluga/rp-66-give-ratel-app-datadog` | RP-66, RP-67: Datadog dashboards and monitors | [proof/rp-66](https://github.com/ratel-ai/ratel-platform/tree/proof/rp-66) |
| 8 | ratel-platform | [#117](https://github.com/ratel-ai/ratel-platform/pull/117) | `plan/phase-0` | RP-3, RP-12, RP-15, RP-21, RP-25 work merged on the plan branch. Contains #116; merge after it | [proof/rp-12](https://github.com/ratel-ai/ratel-platform/tree/proof/rp-12), [rp-15](https://github.com/ratel-ai/ratel-platform/tree/proof/rp-15), [rp-21](https://github.com/ratel-ai/ratel-platform/tree/proof/rp-21), [rp-25](https://github.com/ratel-ai/ratel-platform/tree/proof/rp-25) |

## Notes

- **Twin branch names.** ratel-platform CI builds against the ratel branch with the same name as the PR branch, else the base branch, else `main`. The ratel branches for 3 to 5 are pushed under their ratel-platform names. Local names were `beluga/rp-17-job-ask-allowlist` (4) and `beluga/rp-27-agents-mcp-core` (5).
- **ratel `plan/phase-0`** (a431adea) is an integration branch with no PR: #380 + #377 + #376, merged with no conflicts. It lets ratel-platform #117 CI build against all Phase 1 ratel changes before they merge. Delete it after step 5.
- **Stacked PR.** #380 contains the commits of #378 and #379. After they merge, its diff is the three RP-27, RP-28 and RP-83 commits.
- **Out of scope:** #367, #368, #369 (installer and deploy) and #372 to #375 (twin) are not Phase 1. RP-34 waits for #367 to #369.
