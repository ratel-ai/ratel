# proof/rp-12: verification logs for milestone "Manage Cloud feature flags in PostHog"

Plain-text logs, each headed with its date and the ratel / ratel-platform commit pair it ran on.
Both repos use the branch `beluga/rp-12-manage-cloud-feature`. The ratel baseline is f6f918d9.

| File | Task | What |
|---|---|---|
| rp-63-red.log | RP-63 | account.test.ts on f9f32b33 with the new tests, before the fix: the OAuth parity test fails |
| rp-63-green.log | RP-63 | account.test.ts on a379576a, after the fix: all pass, the project-key test too |
| rp-63-oss-experimental-features.log | RP-63 | the OSS switch tests, unchanged: all pass |

## Final run (RP-64) on the heads: ratel a379576a, ratel-platform 468db8a

Baseline: ratel f6f918d9 (origin/main), ratel-platform plan/phase-0. The full suites are not run here: the plan runs them once in its final step.

| File | What |
|---|---|
| final-oss-flag-tests.log | ratel: experimental-features, account, eval-gate gate and route-handler.apps tests (OSS, no ee/src at test time) |
| final-cloud-flag-tests.log | ratel-platform: feature-flags, flags, flags-registry, overlay-data, diagnostics-menu and composition tests |
| final-typecheck-cloud.log | `pnpm --filter @ratel/platform typecheck` with ee/src linked (Cloud) |
| final-typecheck-oss.log | the same typecheck with ee/src removed and the routes unlinked (OSS) |
| final-check-boundary.log | `pnpm check:boundary` |
| final-oss-no-posthog-import.log | no file under ratel apps/web imports a posthog package |
