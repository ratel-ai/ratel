/**
 * Seed "Site Copilot": a general contractor's field assistant, sent the way an
 * agent that exports OpenTelemetry with content capture on sends it
 * (`POST /v1/traces`, GenAI semantic conventions, API-key auth). Thirty days
 * ending now, about 1,500 turns in conversations of 1 to 6 turns, with the
 * users' asks and the agent's replies. The scenario (topics, tasks, failures,
 * self-corrections, follow-ups) is described in
 * `lib/console/seed/site-copilot-plan.ts` and `site-copilot-turns.ts`.
 *
 *   pnpm --filter @ratel/platform seed              # into the operator's organization, on $DATABASE_URL
 *   DATABASE_URL=postgres://... pnpm --filter @ratel/platform seed [org-slug] [flags]
 *
 *   --slug <slug>      project slug (default site-copilot)
 *   --anchor <iso>     the end of the window (default: now, to the minute)
 *   --turns <n>        turns to plan (default 1500)
 *   --seed <n>         the plan's seed (default fixed, so every run plans the same conversations)
 *   --drain <n>        run n drain ticks afterwards, so the turn ledger (and whatever else is
 *                      registered) is built from what was sent; 0 by default
 *
 * Writes through the traces route handler in-process, so `events`,
 * `trace_events` and `otel_spans` get exactly the rows live ingest writes, and the
 * turn-ledger build is enqueued the way the route enqueues it. Idempotent: the project
 * is deleted (with everything it owns) and created again under the same id before
 * anything is sent. The rest of the pipeline joins as its modules land.
 *
 * Refuses a database that is not on this machine. Prints counts, never text.
 */
import { eq, sql } from "drizzle-orm";
import { siteCopilotCatalogEntries } from "@/lib/console/seed/site-copilot-catalog";
import { assertLocalDatabase } from "@/lib/console/seed/local-database";
import { renderSiteCopilotOtlp, SITE_COPILOT_DAYS } from "@/lib/console/seed/site-copilot-otlp";
import { planSiteCopilot } from "@/lib/console/seed/site-copilot-plan";
import { replaceProject, resolveSeedOrganization } from "@/lib/console/seed/replace-project";
import { parseSeedArgs } from "@/lib/console/seed/seed-args";
import { insertEventsWithMetrics, insertOtelSpans } from "@/lib/ingest/otlp/queries";
import { handleTracesRequest } from "@/lib/ingest/otlp/route-handler";
import { findRuntimeInvokes } from "@/lib/ingest/otlp/runtime-facts-query";
import { upsertRuntimeCatalogEntries } from "@/lib/ingest/runtime-catalog/queries";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { runDrainTick } from "@/lib/jobs/drain";
import { enqueueBuildTraceTurnsJob } from "@/lib/ledger/turns/queries";
import { enqueueClusterIntentsJob } from "@/lib/readings/intent-engine/jobs";
import { enqueueFoldIntentGraphJob } from "@/lib/readings/intent-graph/queries";
import { generateApiKey, hashApiKey } from "@/lib/platform/api-keys";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
import { getOrganizationByProjectId } from "@/lib/platform/identity/queries";
import { organizations } from "@/lib/platform/identity/schema";
import { getLogger } from "@/lib/platform/logger";
import { createApiKey, findActiveApiKeyByHash, touchApiKey } from "@/lib/platform/projects/queries";

const logger = getLogger("scripts/seed");
const PROJECT_NAME = "Site Copilot";
const KEY_NAME = "site-copilot-seed";

/** The seed's own key, created fresh with the project. */
async function createSeedKey(projectId: string): Promise<string> {
  const key = generateApiKey();
  await createApiKey({ projectId, name: KEY_NAME, keyHash: key.hash, keyPrefix: key.prefix });
  return key.plaintext;
}

/**
 * The traces route handler in-process, wired as `app/api/v1/traces/route.ts` wires it,
 * minus the ingest analytics (a seed is not customer traffic) and the post-response
 * drain (`--drain` runs the ticks explicitly once everything is sent).
 */
async function send(apiKey: string, body: object): Promise<Record<string, number>> {
  const request = new Request("http://seed.local/v1/traces", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await handleTracesRequest(request, {
    isDbConfigured,
    hashApiKey,
    findActiveApiKeyByHash,
    touchApiKey,
    insertEventsWithMetrics,
    insertOtelSpans,
    insertTraceEvents,
    getOrganizationByProjectId,
    traceTurns: { enqueueBuild: (projectId) => enqueueBuildTraceTurnsJob(projectId), scheduleProjectDrain: () => {} },
    // The readings' first run for a project comes from this ingest kick (the drain's
    // safety net only revisits projects it has met), so the seed queues them like the route.
    enqueueFoldIntentGraphJob: (projectId, _payload, options) => enqueueFoldIntentGraphJob(projectId, undefined, options),
    enqueueClusterIntentsJob: (projectId, _payload, options) => enqueueClusterIntentsJob(projectId, undefined, options),
    scheduleProjectDrain: () => {},
    findRuntimeInvokes: (projectId, probe) => findRuntimeInvokes(projectId, probe),
  });
  if (response.status !== 202) throw new Error(`ingest returned ${response.status}`);
  const counts = (await response.json()) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(counts).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );
}

/** The drain, `n` ticks: each runs the registered before-steps, the queued jobs, then the after-steps. */
async function drain(n: number): Promise<Array<{ done: number; failed: number }>> {
  const ticks: Array<{ done: number; failed: number }> = [];
  for (let i = 0; i < n; i++) {
    const tick = await runDrainTick();
    ticks.push({ done: tick.done, failed: tick.failed });
    if (!tick.ok) throw new Error(`drain tick ${i + 1} failed: ${tick.error ?? "unknown"}`);
  }
  return ticks;
}

async function storedCounts(
  projectId: string,
): Promise<{
  events: number;
  spans: number;
  traceEvents: Record<string, number>;
  turns: Record<string, number>;
  graphs: number;
  clusters: Record<string, number>;
}> {
  const db = getDb();
  const [events] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from events where project_id = ${projectId}`))
    .rows;
  const [spans] = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from otel_spans where project_id = ${projectId}`)
  ).rows;
  const types = await db.execute<{ type: string; n: number }>(
    sql`select type, count(*)::int as n from trace_events where project_id = ${projectId} group by type order by type`,
  );
  const turns = await db.execute<{ status: string; n: number }>(
    sql`select status, count(*)::int as n from trace_turns where project_id = ${projectId} group by status order by status`,
  );
  const [graphs] = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from intent_graphs where project_id = ${projectId}`)
  ).rows;
  const clusters = await db.execute<{ level: number; n: number }>(
    sql`select level, count(*)::int as n from intent_clusters where project_id = ${projectId} group by level order by level`,
  );
  return {
    events: events?.n ?? 0,
    spans: spans?.n ?? 0,
    traceEvents: Object.fromEntries(types.rows.map((row) => [row.type, row.n])),
    turns: Object.fromEntries(turns.rows.map((row) => [row.status, row.n])),
    graphs: graphs?.n ?? 0,
    clusters: Object.fromEntries(clusters.rows.map((row) => [`level ${row.level}`, row.n])),
  };
}

async function seed() {
  assertLocalDatabase("seed Site Copilot");
  const args = parseSeedArgs(process.argv.slice(2));
  const db = getDb();
  const org = await resolveSeedOrganization(db, args.org);
  const [organization] = await db.select().from(organizations).where(eq(organizations.id, org.id)).limit(1);
  const windowDays = organization ? getAgentHealthLimits(organization).agentHealthWindowDays : 0;
  const project = await replaceProject(db, {
    organizationId: org.id,
    slug: args.slug,
    name: PROJECT_NAME,
    isDemo: true,
  });
  await upsertRuntimeCatalogEntries(siteCopilotCatalogEntries(project.id, new Date(args.anchorMs)), "events", db);
  const apiKey = await createSeedKey(project.id);

  const plan = planSiteCopilot({ seed: args.seed, turns: args.turns });
  const rendered = renderSiteCopilotOtlp(plan, { anchorMs: args.anchorMs, days: SITE_COPILOT_DAYS });
  const accepted: Record<string, number> = {};
  for (const body of rendered.batches) {
    for (const [key, n] of Object.entries(await send(apiKey, body))) {
      accepted[key] = (accepted[key] ?? 0) + n;
    }
  }
  const ticks = await drain(args.drain);
  return { org, windowDays, project, plan, rendered, accepted, ticks, stored: await storedCounts(project.id) };
}

function report(out: Awaited<ReturnType<typeof seed>>): string {
  const { plan, rendered, stored } = out;
  const s = plan.stats;
  const top = (map: Record<string, number>, n: number) =>
    Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key, value]) => `${key} ${value}`)
      .join(", ");
  const lines = [
    "",
    `seeded '${PROJECT_NAME}' in organization '${out.org.slug}' (${out.project.replaced ? "replaced the previous copy" : "new"})`,
    `   project ${out.project.id}`,
    `   window ${new Date(rendered.window.startMs).toISOString()} to ${new Date(rendered.window.endMs).toISOString()}`,
    `   plan: ${s.conversations} conversations, ${s.turns} turns (${s.turnsWithoutTools} without a tool call), ${s.toolCalls} tool calls`,
    `   sent: ${rendered.stats.traces} traces, ${rendered.stats.spans} spans (${rendered.stats.chatSpans} model calls, ${rendered.stats.toolSpans} tool calls) in ${rendered.stats.bodies} requests`,
    `   accepted: ${Object.entries(out.accepted)
      .map(([key, n]) => `${key} ${n}`)
      .join(", ")}`,
    `   stored: events ${stored.events}, otel_spans ${stored.spans}, trace_events ${
      Object.entries(stored.traceEvents)
        .map(([type, n]) => `${type} ${n}`)
        .join(", ") || "none"
    }`,
    `   drained: ${out.ticks.length} tick(s), ${out.ticks.reduce((n, t) => n + t.done, 0)} job(s) done, ${out.ticks.reduce((n, t) => n + t.failed, 0)} failed; trace_turns ${
      Object.entries(stored.turns)
        .map(([status, n]) => `${status} ${n}`)
        .join(", ") || "none"
    }`,
    `   readings: intent_graphs ${stored.graphs}, intent_clusters ${
      Object.entries(stored.clusters)
        .map(([level, n]) => `${level} ${n}`)
        .join(", ") || "none"
    }`,
    `   failed calls: ${top(s.failedCalls, 12)}`,
    `   after a failure: retried ${s.behaviors.retry}, switched ${s.behaviors.switch}, gave up ${s.behaviors.gaveUp}`,
    `   tasks planted (runs): ${top(s.chains, 9)}`,
    `   turns by kind: ${top(s.byKind, 30)}`,
  ];
  if (out.windowDays < SITE_COPILOT_DAYS) {
    lines.push(
      `   warning: '${out.org.slug}' reads Agent health over ${out.windowDays} days, so part of the 30 days stays out of view`,
    );
  }
  return `${lines.join("\n")}\n`;
}

seed()
  .then((out) => {
    process.stdout.write(report(out));
    process.exit(0);
  })
  .catch((err: unknown) => {
    logger.error({ err }, "site copilot seed failed");
    process.exit(1);
  });
