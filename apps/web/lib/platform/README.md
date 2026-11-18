# `lib/platform` (L1)

What every other layer stands on: the database, logging, request plumbing and the three shims
that hide which edition is running. Imports only `lib/contracts`, `lib/composition/ports` and
npm packages.

| Path | Holds |
|---|---|
| `db/client.ts`, `db/pool.ts` | the lazy drizzle client over node-postgres; `isDbConfigured`, `sslConfig`; the pool's connect, query and keepalive timeouts, and dropping a client whose query timed out |
| `db/migrate.ts`, `scripts/migrate.mts` | the migrator; `DATABASE_MIGRATE_ON_BOOT=1` runs it at startup |
| `db/migrations/` | the migrations: one baseline file per schema fragment, then one file per change (`pnpm db:generate`, checked by `pnpm db:check`) |
| `app-config.ts` | `APP_NAME` and `BASE_URL` (origin), from the environment; `apiUrl()` builds `/api/v1` URLs |
| `db/tables.ts`, `db/queries.ts` | barrels over the L1 fragments; higher layers export their own |
| `db/top-queries.ts` | the statements that cost the database most since the last reset (`pg_stat_statements`; null where it is not installed or not preloaded), which the worker logs once a day |
| `process-stats.ts` | `process_stats` once a minute from every process (memory, event loop delay), started where this process exports its own telemetry (`instrumentation.node.ts`) |
| `db/test-support.ts` | `createMigratedPGlite()`: one migrated snapshot per process, a fresh copy per test |
| `db/tenant-scope.test.ts` | upstream's source check, a copy: every read of a big telemetry table names a project, or says why not with a `// cross-project:` comment |
| `db/statement-timeout.ts` | bounded reads with `SET LOCAL statement_timeout` |
| `projects/` | `schema.ts` and `queries.ts` for projects and API keys |
| `organizations.ts` | organizations by id or by project, through the session port: the edition owns the table |
| `projects/names.ts` | project name limits and normalization, safe for client components |
| `projects/capacity.ts` | whether an organization can create another project, and what to say when it cannot |
| `session.ts` | `getSessionContext()`: the session port's user, organization, role and memberships, once per request |
| `entitlements.ts` | `getLimits`, `checkQuota`, `checkMeteredFeature`, `resolvePlanId` over the entitlements port; `planSummary`, `planWithWindow`, `planName`, `planLabel` and `billingSelfServe` over its optional `plans` (no summary, no plan named and no self-serve billing without them) |
| `telemetry.ts` | `trackServerEvent`, `trackProductEvent`, `reportServerException` over the telemetry port |
| `edition-telemetry.ts` | what the instrumentation hands the telemetry port: an uncaught request error (`onRequestError`) and the analytics flush at shutdown, the port loaded only when called; the open-source port has neither, so nothing happens |
| `track-client.ts` | the browser's `track` and `captureClientException` over the browser seam (`contracts/client-analytics.ts`): silent until an edition installs its client, never throwing |
| `env-configured.ts`, `anthropic-backend.ts`, `anthropic-errors.ts` | `configured`: a setting's trimmed value, with the Terraform placeholder counted as unset; `anthropicBackend`: `bedrock` when `ANTHROPIC_BACKEND=bedrock`, else `api`. `ModelNotEnabledError`: a Claude model this AWS account may not call on Bedrock yet (its line says `error_type: model_not_enabled`, and it is reported as an exception once per call). Leaves, so the recorder below reads them without importing the clients |
| `model-call.ts` | the model-call seam: `trackModelCall`, `recordModelCall`, `anthropicUsage` report a model call (tokens, duration, outcome, and `backend`: `bedrock` for a Claude call on Bedrock, else `api`) to a sink that is unset here, so a tracked call only runs; an edition that tracks spend installs one with `setModelCallSink` (owned). A call Ratel pays for (`payer: "ratel"`) is also a `gen_ai.*` span from `MODEL_CALL_TRACER` (ratel-cloud #410). `otel/ratel-export.ts` (owned) sends those spans, and only those, to a Ratel project when `RATEL_SELF_TELEMETRY_API_KEY` and `RATEL_SELF_TELEMETRY_ENDPOINT` are both set (there is no default destination); `RATEL_SELF_TELEMETRY_PROJECT_ID` keeps calls about that project out. A call site may offer its prompt and answer (`content`, built by `model-call-content.ts`, owned: the gen_ai attribute names are spelled there), capped per attribute; `recordTracedModelCall` traces a call timed elsewhere (ratel-cloud #483) |
| `agent-run.ts` | `withAgentRun`: one background job as one agent run in Ratel's own project, an `invoke_agent <name>` root made by its first model call (with the job's ask), its model-call spans as children. It rides its own AsyncLocalStorage, so no other span changes parent (ratel-cloud #483) |
| `project-log-context.ts` | `withProjectLogContext`: background work for one project inside a log context that names it and its organization |
| `deployment-config.ts` | `RATEL_ORG_NAME` validated at boot, and the warnings at boot for a public `BASE_URL` on public defaults |
| `experimental-features.ts` | `experimentalFeatureEnabled(flag)`: a feature's own `FF_*` flag, or `RATEL_EXPERIMENTAL_FEATURES` in the open-source edition (the composition's edition; Cloud ignores it). Every experimental flag reads through it |
| `environment.ts` | `APP_ENV` as the one public runtime value; local-environment allowlist |
| `logger.ts`, `request-log.ts`, `request-log-labels.ts`, `rate-limit.ts`, `http/`, `otel/` | pino with error redaction, per-request logging (with the organization and project slugs), token buckets, body caps, the caller's address (`http/client-address.ts`, the hop the load balancer appended), self-telemetry: the platform's own traces and logs, registered at boot by `instrumentation.node.ts` only when both `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` are set, and flushed on a stop; `OTEL_SERVICE_NAME` names the service (default `ratel-platform`) |
| `support-session.ts` | upstream's `isRestrictedBySupportSession` over the session port's `actingAs`, for copied actions that refuse writes in a support session |
| `api-key-actions.ts` | create and revoke a project's keys, behind the settings server actions; refused in a support session |
| `organization.ts`, `api-keys.ts`, `api-keys-observability.ts` | pure helpers: slugs and roles, key generation and hashing, expired-key reporting |
| `api-key-bearer.ts` | `resolveProjectFromBearer`: the project a `/api/v1/*` bearer key belongs to |
| `api-keys/` | scoped keys (ratel-cloud #428): `scopes.ts` (every scope and the Full, read-only, ingest and custom presets), `policy.ts` (`apiKeyPolicy`, the one place that decides what a key may do), `authenticate.ts` (`authenticateApiKey`, the bearer decision every key route shares: 401, 403 with the missing scope, or the key and its policy) and `routes.ts` (`BEARER_ROUTE_SCOPES`, the scope each bearer route needs; `routes.test.ts` fails a route that authenticates a key without its entry) |
| `format.ts` | `fmtCount`, `fmtCost`: the shared numeric display formatters |

Owned here rather than synced (see `scripts/platform-sync/map.json`): the client, the schema and
query fragments, session, entitlements, telemetry, environment, the OTel config and shutdown, and
the tests that upstream wrote against Cloud-only fixtures.
