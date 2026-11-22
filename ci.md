# CI on the top of the stack

| Repo | Branch (top) | Commit | Run | Result |
|---|---|---|---|---|
| ratel | `beluga/rp-123-embeddings-notice` (#407) | `ef62db61` | [45010765176](https://github.com/ratel-ai/ratel/actions/runs/45010765176) (workflow_dispatch: drafts run nothing on pull_request) | success: changes, design-system, dependency-scan, platform-build, platform-compose, platform-test 1-4, deploy, secret-scan, ci-gate |
| ratel-platform | `beluga/rp-123-embeddings-notice` (#135) | `d7a6cd1` | [45012123573](https://github.com/ratel-ai/ratel-platform/actions/runs/45012123573) (pull_request, built against the ratel twin of the same name) | success: public-ref, cloud, platform-tests 1-4, deploy, terraform, secret-scan |

Fixed on the way (each at the branch that introduced it, then the stack was rebased):
- Lint errors: `strip-client-address.test.ts` (RP-120), code-handoff `sdk-setup.ts` and `load-brief.ts` format (RP-140).
- Tests that pinned the old behavior: ee `core-model-calls.test.ts` (RP-120, #480 stable error_type); core `legacy-route.test.ts` (RP-139, #542 made /dashboards a flag-read page); core `mcp/flag-off.test.ts` sanity floor (RP-141); core `mcp-apps/build.test.ts` replay allowance +10 KB (RP-121 #578, newer @base-ui/react).
- ratel-platform `biome.json` copy override: `observability/error-type.ts` (RP-120), `apis/embeddings/RegionNotice.tsx` (#447).
- secret-scan on workflow_dispatch scans `--all` refs: a fake DB password in another branch's test (`beluga/sandbox-auto-params`, 315d7932) is in `.gitleaksignore` with a comment (top commit).
- Cutover tests (RP-118 deletes the tool): owner decision, #121 retargeted onto #122 and the platform stack placed on #121.
