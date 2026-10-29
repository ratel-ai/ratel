# `lib/platform` (L1)

What every other layer stands on: the database, logging, request plumbing and the three shims
that hide which edition is running. Imports only `lib/contracts`, `lib/composition/ports` and
npm packages.

| Path | Holds |
|---|---|
| `db/client.ts` | the lazy drizzle client over node-postgres; `isDbConfigured`, `sslConfig` |
| `db/migrate.ts`, `scripts/migrate.mts` | the migrator; `DATABASE_MIGRATE_ON_BOOT=1` runs it at startup |
| `db/migrations/` | the generated migration set (`pnpm db:regenerate`, checked by `pnpm db:check`) |
| `db/tables.ts`, `db/queries.ts` | barrels over the L1 fragments; higher layers export their own |
| `db/test-support.ts` | `createMigratedPGlite()`: one migrated snapshot per process, a fresh copy per test |
| `db/statement-timeout.ts` | bounded reads with `SET LOCAL statement_timeout` |
| `identity/`, `projects/` | `schema.ts` and `queries.ts` for users, organizations, memberships, projects, API keys |
| `projects/names.ts` | project name limits and normalization, safe for client components |
| `session.ts` | the principal-to-rows bridge: `getSessionContext()` with user, organization, role, memberships |
| `entitlements.ts` | `getLimits`, `checkQuota`, `checkMeteredFeature`, `resolvePlanId` over the entitlements port |
| `telemetry.ts` | `trackServerEvent`, `trackProductEvent`, `reportServerException` over the telemetry port |
| `environment.ts` | `APP_ENV` as the one public runtime value; local-environment allowlist |
| `logger.ts`, `request-log.ts`, `rate-limit.ts`, `http/`, `otel/` | pino with error redaction, per-request logging, token buckets, body caps, self-telemetry |
| `organization.ts`, `api-keys.ts`, `api-keys-observability.ts` | pure helpers: slugs and roles, key generation and hashing, expired-key reporting |
| `api-key-bearer.ts` | `resolveProjectFromBearer`: the project a `/api/v1/*` bearer key belongs to |
| `format.ts` | `fmtCount`, `fmtCost`: the shared numeric display formatters |

Owned here rather than synced (see `scripts/platform-sync/map.json`): the client, the schema and
query fragments, session, entitlements, telemetry, environment, the OTel config and shutdown, and
the tests that upstream wrote against Cloud-only fixtures.
