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
 *   DATABASE_URL=postgres://... pnpm --filter @ratel/platform seed [organization-id] [flags]
 *
 *   --slug <slug>      project slug (default site-copilot)
 *   --anchor <iso>     the end of the window (default: now, to the minute)
 *   --turns <n>        turns to plan (default 1500)
 *   --seed <n>         the plan's seed (default fixed, so every run plans the same conversations)
 *   --drain <n>        run n drain ticks afterwards, so the turn ledger (and whatever else is
 *                      registered) is built from what was sent; 0 by default. A tick drains
 *                      only the jobs queued before it started: the build takes one, the signal
 *                      run it was asked for the next, and what the run queues the one after.
 *                      A turn closes when the next one starts or on a gap, and otherwise by
 *                      receipt time: roughly half of a fresh seed stays open until the
 *                      30-minute idle window passes (set TRACE_TURNS_IDLE_CLOSE_MS=1000 for one
 *                      more tick to close them, so 4 ticks read everything)
 *
 * Also stores one capability search per topic-opening turn, which is what Test a search offers
 * as real prompts. Writes through the traces route handler in-process, so `events`,
 * `trace_events` and `otel_spans` get exactly the rows live ingest writes, and the
 * turn-ledger build is enqueued the way the route enqueues it. Idempotent: the project
 * is deleted (with everything it owns) and created again under the same id before
 * anything is sent. The rest of the pipeline joins as its modules land.
 *
 * Refuses a database that is not on this machine. Prints counts, never text.
 */
import { sql } from "drizzle-orm";
import { assertLocalDatabase } from "@/lib/console/seed/local-database";
import { resolveSeedOrganization } from "@/lib/console/seed/replace-project";
import { parseSeedArgs } from "@/lib/console/seed/seed-args";
import { SITE_COPILOT_DAYS } from "@/lib/console/seed/site-copilot-otlp";
import { SITE_COPILOT_PROJECT_NAME, seedSiteCopilot } from "@/lib/console/seed/site-copilot-seed";
import { runDrainTick } from "@/lib/jobs/drain";
import { getDb } from "@/lib/platform/db/client";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
import { getLogger } from "@/lib/platform/logger";

const logger = getLogger("scripts/seed");
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
  signalRuns: Record<string, number>;
  signals: Record<string, number>;
  signalKinds: Record<string, number>;
  selfCorrections: Record<string, number>;
  workflowLabels: number;
  workflowVerdicts: number;
  topics: Record<string, number>;
  turnTopics: Record<string, number>;
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
  const signalRuns = await db.execute<{ status: string; trigger: string; n: number }>(
    sql`select status, trigger, count(*)::int as n from trace_signal_runs where project_id = ${projectId} group by status, trigger order by status, trigger`,
  );
  const signals = await db.execute<{ status: string; n: number }>(
    sql`select status, count(*)::int as n from trace_signals where project_id = ${projectId} group by status order by status`,
  );
  const signalKinds = await db.execute<{ kind: string; n: number }>(
    sql`select kind, count(*)::int as n from trace_signals where project_id = ${projectId} and status = 'open' group by kind order by n desc, kind`,
  );
  const selfCorrections = await db.execute<{ kind: string; n: number }>(
    sql`select kind, count(*)::int as n from trace_self_corrections where project_id = ${projectId} group by kind order by n desc, kind`,
  );
  const [labels] = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from trace_workflow_labels where project_id = ${projectId}`)
  ).rows;
  const [verdicts] = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from trace_workflow_verdicts where project_id = ${projectId}`)
  ).rows;
  const topics = await db.execute<{ label_source: string; n: number }>(
    sql`select label_source, count(*)::int as n from trace_topics where project_id = ${projectId} and retired_at is null group by label_source order by label_source`,
  );
  const turnTopics = await db.execute<{ verdict: string; n: number }>(
    sql`select verdict, count(*)::int as n from trace_turn_topics where project_id = ${projectId} group by verdict order by verdict`,
  );
  return {
    events: events?.n ?? 0,
    spans: spans?.n ?? 0,
    traceEvents: Object.fromEntries(types.rows.map((row) => [row.type, row.n])),
    turns: Object.fromEntries(turns.rows.map((row) => [row.status, row.n])),
    graphs: graphs?.n ?? 0,
    clusters: Object.fromEntries(clusters.rows.map((row) => [`level ${row.level}`, row.n])),
    signalRuns: Object.fromEntries(signalRuns.rows.map((row) => [`${row.status} (${row.trigger})`, row.n])),
    signals: Object.fromEntries(signals.rows.map((row) => [row.status, row.n])),
    signalKinds: Object.fromEntries(signalKinds.rows.map((row) => [row.kind, row.n])),
    selfCorrections: Object.fromEntries(selfCorrections.rows.map((row) => [row.kind, row.n])),
    workflowLabels: labels?.n ?? 0,
    workflowVerdicts: verdicts?.n ?? 0,
    topics: Object.fromEntries(topics.rows.map((row) => [row.label_source, row.n])),
    turnTopics: Object.fromEntries(turnTopics.rows.map((row) => [row.verdict, row.n])),
  };
}

async function seed() {
  assertLocalDatabase("seed Site Copilot");
  const args = parseSeedArgs(process.argv.slice(2));
  const db = getDb();
  const org = await resolveSeedOrganization(args.org);
  const windowDays = getAgentHealthLimits(org).agentHealthWindowDays;
  const seeded = await seedSiteCopilot(
    { organizationId: org.id, slug: args.slug, anchorMs: args.anchorMs, turns: args.turns, seed: args.seed },
    db,
  );
  // One tick drains only the jobs queued before it started, so build, run and what the run
  // queues take one tick each (one more when the idle close is what closes the last turns).
  const ticks = await drain(args.drain);
  return { org, windowDays, ...seeded, ticks, stored: await storedCounts(seeded.projectId) };
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
    `seeded '${SITE_COPILOT_PROJECT_NAME}' in organization '${out.org.slug}' (${out.replaced ? "replaced the previous copy" : "new"})`,
    `   project ${out.projectId}`,
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
    `   agent health: trace_signal_runs ${
      Object.entries(stored.signalRuns)
        .map(([key, n]) => `${key} ${n}`)
        .join(", ") || "none"
    }; trace_signals ${
      Object.entries(stored.signals)
        .map(([status, n]) => `${status} ${n}`)
        .join(", ") || "none"
    }${Object.keys(stored.signalKinds).length > 0 ? ` (open kinds: ${top(stored.signalKinds, 8)})` : ""}`,
    `   self-corrections: ${top(stored.selfCorrections, 8) || "none"}; workflow labels ${stored.workflowLabels}, verdicts ${
      stored.workflowVerdicts
    }${stored.workflowLabels + stored.workflowVerdicts === 0 ? " (skipped without a model key)" : ""}`,
    `   topics: trace_topics ${
      Object.entries(stored.topics)
        .map(([source, n]) => `${source} ${n}`)
        .join(", ") || "none"
    }; trace_turn_topics ${
      Object.entries(stored.turnTopics)
        .map(([verdict, n]) => `${verdict} ${n}`)
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
