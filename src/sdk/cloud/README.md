# `@ratel-ai/cloud`

Client for [Ratel Cloud](https://github.com/ratel-ai/ratel), authenticated with a per-project API
key (`rtl_...`). Everything the Cloud exposes to an SDK host goes through one `CloudClient`:

- **Trace-event export** — drains a `TraceSession` (from `@ratel-ai/sdk`) on a timer and POSTs
  batches to `POST /api/v1/trace-events`, with idempotent retries.
- **Skill-catalog sync** — pull/cache of the project's published skills via
  `GET /api/v1/catalog` (ETag / `If-None-Match`), hot-reloaded into a live `SkillCatalog`
  (ADR-0014).
- **Suggestion review** — typed `list` / `get` / `approve` / `reject` / `generate` over the
  project-key suggestions REST.
- **Run metrics** — manual `reportRunMetrics()` for the coarse per-run token/cost stream
  (`POST /api/v1/events`).

## Layout

- `src/client.ts` — `CloudClient` (config + env resolution)
- `src/exporter.ts` — `CloudExporter`, the drain-timer trace exporter (ADR-0013)
- `src/catalog-sync.ts` — `SkillSync` pull/cache engine and its ownership rules
- `src/suggestions.ts` — suggestions client
- `src/http.ts`, `src/errors.ts`, `src/types.ts` — transport, typed errors, wire types
- `src/testing/mock-cloud.ts` — in-process mock Cloud used by tests and e2e

## Usage

```ts
import { SkillCatalog, ToolCatalog, TraceSession } from "@ratel-ai/sdk";
import { CloudClient } from "@ratel-ai/cloud";

// Config: pass explicitly or via RATEL_CLOUD_URL / RATEL_CLOUD_API_KEY.
const cloud = new CloudClient({ baseUrl: "https://cloud.example.com", apiKey: "rtl_..." });

// One session per process: single seq counter, single drain point.
const session = new TraceSession({ sessionId: crypto.randomUUID(), harness: "my-agent" });
const tools = new ToolCatalog({ traceSession: session });
const skills = new SkillCatalog({ traceSession: session });

// Export traces (the session should have exactly ONE drainer — this exporter).
const exporter = cloud.createExporter(session);
exporter.start();

// Pull the published catalog and keep it fresh; approved/auto-applied
// suggestions arrive through refresh().
const sync = await cloud.syncSkills(skills, { traceSession: session });
sync.start();

// Review suggestions in code.
const { suggestions } = await cloud.suggestions.list({ status: "pending" });
await cloud.suggestions.approve(suggestions[0].id);
await sync.refresh(); // the approved skill lands in the catalog

// On shutdown.
sync.stop();
await exporter.shutdown();
```

Cloud is the source of truth only for the skills it synced: a host-registered skill whose id
collides with a wire skill is never clobbered (it is reported in `SyncResult.conflicts`). There is
no disk cache: an offline start has no cloud skills until the first successful resync
(`createSkillSync()` + `start()` tolerates that; `syncSkills()` throws).

## Build & test

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```
