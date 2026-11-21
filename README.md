# proof/rp-12: verification logs for milestone "Manage Cloud feature flags in PostHog"

Plain-text logs, each headed with its date and the ratel / ratel-platform commit pair it ran on.
Both repos use the branch `beluga/rp-12-manage-cloud-feature`. The ratel baseline is f6f918d9.

| File | Task | What |
|---|---|---|
| rp-63-red.log | RP-63 | account.test.ts on f9f32b33 with the new tests, before the fix: the OAuth parity test fails |
| rp-63-green.log | RP-63 | account.test.ts on a379576a, after the fix: all pass, the project-key test too |
| rp-63-oss-experimental-features.log | RP-63 | the OSS switch tests, unchanged: all pass |
