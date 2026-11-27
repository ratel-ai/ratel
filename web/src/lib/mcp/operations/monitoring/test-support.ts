import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { loadStoredPropertyNames } from "@/lib/ingest/properties/store";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchResult, type DispatchSuccess, dispatchOperation } from "@/lib/mcp/dispatch";
import type { McpOperation } from "@/lib/mcp/registry";
import { buildRegistry } from "@/lib/mcp/registry";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { metricSeams, runQuery } from "@/lib/synthesis/metrics/query";
import { createPgRqlExecutor } from "@/lib/synthesis/rql/adapters/pg-executor";
import { sqlQueryRunner } from "@/lib/synthesis/rql/query";
import { createRqlGate } from "@/lib/synthesis/rql/run";
import { pglitePoolOf } from "@/lib/synthesis/rql/tests/test-support";
import type { SealedDestination } from "@/lib/views/alerts/destinations";
import { loadWidget } from "@/lib/views/dashboards/data";
// What these modules own is read through what they register.
import "@/lib/views/dashboards/data";
import { scorePresetTraces } from "@/lib/views/scorers/preset";
import { countLastWeek, previewScorer } from "@/lib/views/scorers/preview";
import { countMatchingTraces, latestMatchingTraces } from "@/lib/views/scorers/traces";
import type { MonitoringDeps } from "./deps";

export const ORG = "22222222-2222-4222-8222-222222222222";
export const PROJECT = "11111111-1111-4111-8111-111111111111";
export const OTHER = "33333333-3333-4333-8333-333333333333";
export const SECRET_KEY = "a-test-key-of-more-than-thirty-two-characters";
export const NOW = new Date("2026-11-24T12:00:00Z");

export const KEY_AUTH: McpAuthContext = {
  kind: "api-key",
  projectId: PROJECT,
  apiKeyId: "key-1",
  scopes: ["*"],
  organization: { id: ORG, slug: "acme", effectivePlan: "pro" },
};

/** A person of `ORG`, or of another organization. */
export function personAuth(role = "admin", organizationId = ORG): McpAuthContext {
  return {
    kind: "oauth",
    externalUserId: "user_1",
    userId: "u1",
    memberships: [
      {
        organizationId,
        role,
        organization: { id: organizationId, slug: "acme", effectivePlan: "pro" },
      },
    ],
  };
}

export interface Monitoring {
  client: PGlite;
  db: ReturnType<typeof getDb>;
  deps: MonitoringDeps;
  /** The state a test changes. */
  set: {
    on: boolean;
    channels: Awaited<ReturnType<MonitoringDeps["slack"]["listChannels"]>>;
    access: Awaited<ReturnType<MonitoringDeps["slack"]["channelAccess"]>>;
    post: Awaited<ReturnType<MonitoringDeps["slack"]["post"]>>;
  };
  posted: { destination: SealedDestination; text: string }[];
  events: { event: string; fields: Record<string, unknown> }[];
  /** A call as a client makes it, through dispatch. */
  call(id: string, params?: object, auth?: McpAuthContext): Promise<DispatchResult>;
  /** The data of a call that must succeed. */
  data<T = Record<string, unknown>>(id: string, params?: object): Promise<T>;
}

/** The monitoring tools over a real database, with Slack and telemetry in memory. */
export async function monitoring(
  operationsOf: (deps: MonitoringDeps) => McpOperation[],
): Promise<Monitoring> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Agent', 'agent'), ('${OTHER}', '${ORG}', 'Other', 'other');
  `);
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  const set: Monitoring["set"] = {
    on: true,
    channels: { ok: true, channels: [], partial: false },
    access: { ok: true, teamId: "T1", name: "alerts" },
    post: { ok: true },
  };
  const events: Monitoring["events"] = [];
  const posted: Monitoring["posted"] = [];
  const preview = {
    latest: (...[p, t, n]: Parameters<typeof latestMatchingTraces>) =>
      latestMatchingTraces(p, t, n, db),
    count: (...[p, t, s]: Parameters<typeof countMatchingTraces>) =>
      countMatchingTraces(p, t, s, db),
    judge: async () => [],
    preset: (...[p, c, t, k]: Parameters<typeof scorePresetTraces>) =>
      scorePresetTraces(p, c, t, k, db),
  };
  const deps: MonitoringDeps = {
    enabled: async () => set.on,
    db: () => db,
    previewScorer: (projectId, draft) => previewScorer(projectId, draft, preview),
    countLastWeek: (projectId, target) => countLastWeek(projectId, target, NOW, preview),
    runQuery: (projectId, query, scope) => runQuery(projectId, query, scope, db),
    loadWidget: (projectId, widget, scope) =>
      // Kind sql through the console's own read: it drops the page's filter and keeps a refusal.
      widget.query.kind === "sql"
        ? loadWidget(projectId, widget, scope, db as never)
        : runQuery(projectId, widget.query, scope, db),
    canSeal: () => true,
    secretKey: SECRET_KEY,
    slack: {
      appStatus: async () => ({ kind: "organization", clientId: "1.2" }),
      listChannels: async () => set.channels,
      channelAccess: async () => set.access,
      revoke: async () => {},
      post: async (destination, { text }) => {
        posted.push({ destination, text });
        return set.post;
      },
    },
    trackServerEvent: async (event, _context, fields) => {
      events.push({ event, fields: fields ?? {} });
    },
    now: () => NOW,
  };
  runRqlOn(client, db);
  const registry = buildRegistry(operationsOf(deps));
  const call: Monitoring["call"] = (id, params = {}, auth = KEY_AUTH) =>
    dispatchOperation(id, params, {
      registry,
      auth,
      projectOwner: async (projectId) =>
        [PROJECT, OTHER].includes(projectId) ? { organizationId: ORG } : null,
    });
  return {
    client,
    db,
    deps,
    set,
    posted,
    events,
    call,
    async data(id, params) {
      const result = await call(id, params);
      if (!result.ok) throw new Error(`${id}: ${result.error}: ${result.message}`);
      return (result as DispatchSuccess).data as never;
    },
  };
}

/** One settled trace, an hour before `NOW`. */
export function insertTrace(client: PGlite, traceId: string, durationMs = 100, failed = false) {
  const at = new Date(NOW.getTime() - 3_600_000);
  return client.query(
    `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
       input_tokens, output_tokens, cost_usd, spans_max_received_at, updated_at)
     values ($1, $2, $3, $4, $5, 1, 1, 0, $3, $3)`,
    [PROJECT, traceId, at, durationMs, failed],
  );
}

/**
 * Kind `sql` on this database: the RQL runner over the one PGlite connection. The seam has no flag
 * check: the tools check `customMonitoring` of the caller (`set.on`) before it.
 */
function runRqlOn(client: PGlite, db: ReturnType<typeof getDb>) {
  // PGlite has one connection: an RQL transaction waits for the one before it.
  const pool = pglitePoolOf(client);
  metricSeams.sql = sqlQueryRunner({
    run: { executor: createPgRqlExecutor(pool), gate: createRqlGate(), observe: async () => {} },
    properties: (projectId) => loadStoredPropertyNames(projectId, db),
  });
}
