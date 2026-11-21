# proof/rp-34: apps/web moved to src

Pair: ratel `refactor/move-apps-web-to-src` 4391fb6d (#382) and ratel-platform `refactor/move-apps-web-to-src` 6582742 (#118), run on 2026-11-21.

| File | What |
|---|---|
| 01-cloud-boot.png | Local Cloud boot: `next build` with `RATEL_COMPOSITION=cloud`, then the standalone `src/server.js` as the image runs it, `DEV_AUTH_BYPASS=1`, a fresh Postgres migrated by `ee/src/db/bundle-migrator.mjs`. `/` redirects to `/organizations` and the Cloud launch gate shows the waitlist. |
| 02-typecheck-oss.log | `pnpm --filter @ratel/platform typecheck` without ee/src |
| 03-typecheck-cloud.log | The same with ee/src linked (`RATEL_COMPOSITION=cloud`) |
| 04-build-cloud-tail.log | End of the local Cloud `next build` (exit 0) |
| 05-health.json | `GET /api/health` on the booted server |
