# proof/rp-34: apps/web moved to src

Final pair: ratel `9ceeae3f` (#382) and ratel-platform `c0d67c56` (#118), both on branch `refactor/move-apps-web-to-src`. Recorded on 2026-11-21.

| File | What |
|---|---|
| `01-cloud-boot.png` | Local Cloud boot (1440x900, 8-bit RGB PNG): `next build` with `RATEL_COMPOSITION=cloud`, the standalone `src/server.js`, `DEV_AUTH_BYPASS=1`, a fresh Postgres migrated by `ee/src/db/bundle-migrator.mjs`. The Cloud launch gate shows the waitlist. |
| `pr-382.json` | `gh pr view 382 -R ratel-ai/ratel --json number,isDraft,state,headRefName,headRefOid,body`. Head `9ceeae3f`. |
| `pr-118.json` | The same for ratel-platform #118. Head `c0d67c56`. |
| `leftovers.txt` | The monorepo leftovers removed in #382 (RP-35), each with its reason, and what was kept. |
| `ci-ratel-44960332927.json` | ratel CI (workflow_dispatch, since draft PRs skip CI) on `9ceeae3f`: every job's conclusion, with the commit pair. All success. |
| `ci-ratel-platform-44960334906.json` | ratel-platform CI on `c0d67c56`, built against ratel `refactor/move-apps-web-to-src`: every job's conclusion, with the commit pair. All success. |
| `02-typecheck-oss.log`, `03-typecheck-cloud.log`, `04-build-cloud-tail.log`, `05-health.json` | Earlier local runs on ratel `4391fb6d` / ratel-platform `6582742`: OSS and Cloud typecheck, the end of the Cloud build, and `GET /api/health`. |

No CI job failed, so there are no failed-job logs.
