/**
 * RTL-314 load test: one project backfills thousands of 700-span trace batches while a second
 * project sends normal traffic and its console is read, all in ONE all-in-one process (the
 * self-hosted topology, and the one the incident hit: ingest and console on the same processes).
 *
 *   DATABASE_URL=postgres://postgres@localhost:55432/ratel \
 *     pnpm --filter @ratel/platform exec tsx scripts/load-test-ingest-queue.mts --mode queued
 *
 *   --mode inline|queued   inline: today's path (EXPERIMENTAL_INGEST_QUEUE off); queued: on
 *   --baseline-s <n>       seconds of quiet traffic first (default 20)
 *   --load-s <n>           seconds measured while the backfill runs (default 60)
 *   --backfill <n>         700-span batches the busy project sends (default 2000)
 *   --senders <n>          the busy project's concurrent senders (default 8)
 *   --split                queued only: this process accepts (APP_ROLE=api) and a second process
 *                          persists (APP_ROLE=persist's lane), the Cloud topology
 *   --out <dir>            where the JSON summary goes (default ../.beluga/scratch/load-test)
 *
 * The traces route handler runs in-process with the production write path (as `scripts/seed.mts`
 * does); only API-key lookup is stubbed. Quiet traffic: a 20-span batch every 250 ms. Console
 * traffic: the Runs page's trace list (`listTraces`) for the quiet project every 250 ms. Refuses a
 * database that is not on this machine: it writes thousands of batches.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";

const { values: args } = parseArgs({
  options: {
    mode: { type: "string", default: "queued" },
    "baseline-s": { type: "string", default: "20" },
    "load-s": { type: "string", default: "60" },
    backfill: { type: "string", default: "2000" },
    senders: { type: "string", default: "8" },
    out: { type: "string", default: "../.beluga/scratch/load-test" },
    split: { type: "boolean", default: false },
    persister: { type: "boolean", default: false },
  },
});
const MODE = args.mode === "inline" ? "inline" : "queued";
const SPLIT = MODE === "queued" && args.split === true;
// Before any module reads the config.
process.env.APP_ROLE = args.persister ? "persist" : SPLIT ? "api" : "all";
process.env.EXPERIMENTAL_INGEST_QUEUE = MODE === "queued" ? "1" : "0";
process.env.LOG_LEVEL ??= "warn";
process.env.RATEL_CRON = "external";

const { assertLocalDatabase } = await import("@/lib/console/seed/local-database");
const { getDb } = await import("@/lib/platform/db/client");
const { ingestPersistDeps } = await import("@/lib/composition/registry");
const { handleTracesRequest } = await import("@/lib/ingest/otlp/route-handler");
const q = await import("@/lib/ingest/otlp/queries");
const { insertTraceEvents } = await import("@/lib/ingest/trace-events/queries");
const { findRuntimeInvokes } = await import("@/lib/ingest/otlp/runtime-facts-query");
const { ingestQueueAcceptDeps } = await import("@/lib/ingest/queue/register");
const { listTraces } = await import("@/lib/synthesis/traces/queries");
const { drainProjectJobs } = await import("@/lib/jobs/store");
const { enqueueBuildTraceTurnsJob } = await import("@/lib/ledger/turns/queries");

assertLocalDatabase("run the ingest load test");

if (args.persister) {
  // The second process of --split: the ingest lane alone, until the parent stops it.
  const { ingestQueueLanes } = await import("@/lib/ingest/queue/register");
  const { startWorker } = await import("@/lib/jobs/worker");
  startWorker({
    analysis: false,
    extraLanes: ingestQueueLanes({ persistDeps: ingestPersistDeps }),
    drain: async () => ({ done: 0, failed: 0 }),
    sweep: async () => {},
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 250))),
  });
  await new Promise(() => {});
}
const db = getDb();

const BUSY = "aaaaaaaa-0000-4000-8000-000000000001";
const QUIET = "bbbbbbbb-0000-4000-8000-000000000002";
const { LOCAL_ORGANIZATION_ID: ORG } = await import("@/lib/adapters/oss/session");

async function resetProjects(): Promise<void> {
  await db.execute(sql`delete from projects where id in (${BUSY}, ${QUIET})`);
  await db.execute(sql`delete from ingest_batches`);
  for (const [id, slug] of [
    [BUSY, "loadtest-busy"],
    [QUIET, "loadtest-quiet"],
  ]) {
    await db.execute(
      sql`insert into projects (id, organization_id, name, slug) values (${id}, ${ORG}, ${slug}, ${slug})`,
    );
  }
}

let spanCounter = 0;
const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
const PROMPT = "Summarize the site inspection notes for the east wing and list open issues. ".repeat(6);

/** An export of one trace with `n` spans: an agent run and its model calls, ids never reused. */
function exportBody(n: number, ageMs = 0): string {
  const traceId = hex(++spanCounter, 32);
  const start = BigInt(Date.now() - ageMs) * 1_000_000n;
  const spans = Array.from({ length: n }, (_, i) => {
    const s = start + BigInt(i) * 1_000_000n;
    return {
      traceId,
      spanId: hex(++spanCounter, 16),
      name: i === 0 ? "invoke_agent site-copilot" : "chat claude-sonnet-5-5",
      kind: 3,
      startTimeUnixNano: s.toString(),
      endTimeUnixNano: (s + 900_000_000n).toString(),
      attributes: [
        { key: "gen_ai.operation.name", value: { stringValue: i === 0 ? "invoke_agent" : "chat" } },
        { key: "gen_ai.provider.name", value: { stringValue: "anthropic" } },
        { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-5-5" } },
        { key: "gen_ai.usage.input_tokens", value: { intValue: "1200" } },
        { key: "gen_ai.usage.output_tokens", value: { intValue: "300" } },
        { key: "gen_ai.conversation.id", value: { stringValue: `conv-${traceId.slice(-6)}` } },
        { key: "gen_ai.input.messages", value: { stringValue: JSON.stringify([{ role: "user", content: PROMPT }]) } },
      ],
    };
  });
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "site-copilot" } }] },
        scopeSpans: [{ scope: { name: "ratel" }, spans }],
      },
    ],
  });
}

function kickProjectJobs(projectId: string): void {
  void drainProjectJobs(projectId).catch(() => {});
}

const runtime = { persistDeps: ingestPersistDeps };
// No Next request here: run the after-response callback on the next turn, as `after()` would.
const ingestQueue = ingestQueueAcceptDeps(runtime, (callback) => {
  setImmediate(() => void callback());
});

function keyFor(hash: string) {
  const projectId = hash.endsWith("busy") ? BUSY : QUIET;
  return {
    id: `key-${projectId}`,
    projectId,
    name: "loadtest",
    keyHash: hash,
    keyPrefix: "rtl_load",
    createdAt: new Date(),
    lastUsedAt: new Date(),
    revokedAt: null,
    expiresAt: null,
    scopes: ["*"],
    rateLimitPerMinute: null,
  };
}

/** The traces route as `app/api/v1/traces/route.ts` wires it, with the key lookup stubbed. */
async function postTraces(project: "busy" | "quiet", body: string): Promise<number> {
  const response = await handleTracesRequest(
    new Request("http://localhost/api/v1/traces", {
      method: "POST",
      headers: { authorization: `Bearer rtl_${project}`, "content-type": "application/json" },
      body,
    }),
    {
      scope: "ingest:traces",
      isDbConfigured: () => true,
      hashApiKey: (key) => `hash:${key.replace("rtl_", "")}`,
      findActiveApiKeyByHash: async (hash) => keyFor(hash),
      touchApiKey: async () => {},
      insertEventsWithMetrics: q.insertEventsWithMetrics,
      insertOtelSpans: q.insertOtelSpans,
      findStoredOtelSpans: q.findStoredOtelSpans,
      insertTraceEvents,
      traceTurns: { enqueueBuild: (id) => enqueueBuildTraceTurnsJob(id), scheduleProjectDrain: kickProjectJobs },
      scheduleProjectDrain: kickProjectJobs,
      findRuntimeInvokes: (id, probe) => findRuntimeInvokes(id, probe),
      agentSpanDedupe: { findTracesWithModelCalls: (id, ids) => q.findTracesWithModelCalls(id, ids) },
      shouldSampleSuccess: () => false,
      shouldSampleRejection: () => false,
      logWarn: () => {},
      ingestQueue,
    },
  );
  return response.status;
}

interface Sample {
  at: number;
  ms: number;
  ok: boolean;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function stats(samples: Sample[]) {
  const ms = samples.map((s) => s.ms);
  return {
    n: samples.length,
    errors: samples.filter((s) => !s.ok).length,
    p50: Math.round(percentile(ms, 50)),
    p95: Math.round(percentile(ms, 95)),
    p99: Math.round(percentile(ms, 99)),
    max: Math.round(Math.max(...ms)),
  };
}

/** Run `step` every `everyMs` until `stopAt`, one at a time, recording how long each took. */
async function paced(everyMs: number, stopAt: () => boolean, step: () => Promise<boolean>): Promise<Sample[]> {
  const samples: Sample[] = [];
  while (!stopAt()) {
    const started = performance.now();
    let ok = false;
    try {
      ok = await step();
    } catch {
      ok = false;
    }
    const ms = performance.now() - started;
    samples.push({ at: Date.now(), ms, ok });
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, everyMs - ms)));
  }
  return samples;
}

async function quietAndConsole(seconds: number) {
  const stopAt = Date.now() + seconds * 1000;
  const done = () => Date.now() >= stopAt;
  const [ingest, consoleReads] = await Promise.all([
    paced(250, done, async () => (await postTraces("quiet", exportBody(20, 60_000))) === 202),
    paced(250, done, async () => {
      await listTraces(QUIET, {});
      return true;
    }),
  ]);
  return { ingest: stats(ingest), console: stats(consoleReads) };
}

async function backfill(total: number, senders: number, stop: () => boolean) {
  let sent = 0;
  const latencies: Sample[] = [];
  await Promise.all(
    Array.from({ length: senders }, async () => {
      while (sent < total && !stop()) {
        sent++;
        const started = performance.now();
        const status = await postTraces("busy", exportBody(700, 3_600_000)).catch(() => 0);
        latencies.push({ at: Date.now(), ms: performance.now() - started, ok: status === 202 });
      }
    }),
  );
  return { sent, latencies };
}

async function queueWait(projectId: string) {
  const rows = await db.execute<{ status: string; n: number; p50: number | null; p95: number | null }>(sql`
    select status, count(*)::int as n,
      percentile_cont(0.5) within group (order by extract(epoch from (coalesce(finished_at, now()) - received_at)) * 1000) as p50,
      percentile_cont(0.95) within group (order by extract(epoch from (coalesce(finished_at, now()) - received_at)) * 1000) as p95
    from ingest_batches where project_id = ${projectId} group by status order by status
  `);
  return rows.rows.map((r) => ({ ...r, p50: r.p50 && Math.round(r.p50), p95: r.p95 && Math.round(r.p95) }));
}

async function main() {
  const { spawn } = await import("node:child_process");
  const persister = SPLIT
    ? spawn(process.execPath, [...process.execArgv, process.argv[1], "--persister", "--mode", "queued"], {
        stdio: "ignore",
        env: process.env,
      })
    : null;
  const baselineS = Number(args["baseline-s"]);
  const loadS = Number(args["load-s"]);
  await resetProjects();
  // Warm up: a little data in the quiet project, so its trace list reads something.
  for (let i = 0; i < 20; i++) await postTraces("quiet", exportBody(20, 120_000));
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  console.log(`[${MODE}] baseline ${baselineS}s`);
  const baseline = await quietAndConsole(baselineS);
  console.log(`[${MODE}] baseline`, JSON.stringify(baseline));

  console.log(`[${MODE}] load ${loadS}s with a ${args.backfill}-batch backfill`);
  let stopBackfill = false;
  const loadStarted = Date.now();
  const busy = backfill(Number(args.backfill), Number(args.senders), () => stopBackfill);
  const underLoad = await quietAndConsole(loadS);
  stopBackfill = true;
  const busyResult = await busy;
  const elapsedS = (Date.now() - loadStarted) / 1000;
  console.log(`[${MODE}] under load`, JSON.stringify(underLoad));

  const summary = {
    mode: SPLIT ? "queued-split" : MODE,
    baselineS,
    loadS,
    backfillSent: busyResult.sent,
    backfillAccepted: busyResult.latencies.filter((s) => s.ok).length,
    backfillAcceptsPerS: Math.round((busyResult.latencies.length / elapsedS) * 10) / 10,
    backfillIngest: stats(busyResult.latencies),
    baseline,
    underLoad,
    ratio: {
      quietIngestP50: Math.round((underLoad.ingest.p50 / baseline.ingest.p50) * 100) / 100,
      quietIngestP95: Math.round((underLoad.ingest.p95 / baseline.ingest.p95) * 100) / 100,
      consoleP50: Math.round((underLoad.console.p50 / baseline.console.p50) * 100) / 100,
      consoleP95: Math.round((underLoad.console.p95 / baseline.console.p95) * 100) / 100,
    },
    queueWaitMs:
      MODE === "queued" ? { quiet: await queueWait(QUIET), busy: await queueWait(BUSY) } : null,
  };
  console.log(JSON.stringify(summary, null, 2));
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, `${summary.mode}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  persister?.kill();
  process.exit(0);
}

await main();
