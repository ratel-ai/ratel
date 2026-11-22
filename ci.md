# CI on the top of the Evals stack

| Repo | Branch (top) | Commit | Run | Result |
|---|---|---|---|---|
| ratel | `beluga/rp-149-evals-tables` (#408) | `6ceb27bc` | [45020652540](https://github.com/ratel-ai/ratel/actions/runs/45020652540) (workflow_dispatch: drafts run nothing on pull_request) | success: changes, design-system, dependency-scan, platform-build, platform-compose, platform-test 1-4, deploy, secret-scan, ci-gate |
| ratel-platform | `beluga/rp-149-evals-tables` (#137) | `179ed57` | [45020646795](https://github.com/ratel-ai/ratel-platform/actions/runs/45020646795) (pull_request, built against the ratel twin of the same name) | success: public-ref, cloud, platform-tests 1-4, deploy, terraform, secret-scan |

Fixed on the way:
- The first dispatch on `2e67857e` ([45020208657](https://github.com/ratel-ai/ratel/actions/runs/45020208657)) passed every build and test job (platform-test 1-4, platform-build, platform-compose) and failed only secret-scan: workflow_dispatch scans `--all` refs, and 11 test-generated API key prefixes in another branch's proof log (`proof/ports`, `rp-122/logs/tests-changed-1.log`, commit `495bc9d`) matched `generic-api-key`. They are keys a unit test makes on a throwaway PGlite; their fingerprints are in `.gitleaksignore` with a comment (top commit `6ceb27bc`, RP-152).
- Cloud: the core's new `FF_EVALS` switch needs a Cloud flag for the flags port to decide it per organization or project; the twin adds `cloud-evals` (RP-152).
