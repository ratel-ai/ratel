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
 *
 * Writes through the traces route handler in-process, so `events`,
 * `trace_events` and `otel_spans` get exactly the rows live ingest writes.
 * Idempotent: the project is deleted (with everything it owns) and created
 * again under the same id before anything is sent. Turn building and the rest
 * of the pipeline stay out until those modules land.
 *
 * Refuses a database that is not on this machine. Prints counts, never text.
 */
import { eq, sql } from "drizzle-orm";
import { siteCopilotCatalogEntries } from "@/lib/console/seed/site-copilot-catalog";
import { assertLocalDatabase } from "@/lib/console/seed/local-database";
import {
  chatDedupeHash,
  renderSiteCopilotOtlp,
  SITE_COPILOT_DAYS,
  type SiteChatSpan,
} from "@/lib/console/seed/site-copilot-otlp";
import { planSiteCopilot, SITE_COPILOT_SEED, SITE_COPILOT_TURNS } from "@/lib/console/seed/site-copilot-plan";
import { replaceProject, resolveSeedOrganization } from "@/lib/console/seed/replace-project";
import { insertEventsWithMetrics, insertOtelSpans } from "@/lib/ingest/otlp/queries";
import { handleTracesRequest } from "@/lib/ingest/otlp/route-handler";
import { upsertRuntimeCatalogEntries } from "@/lib/ingest/runtime-catalog/queries";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { generateApiKey, hashApiKey } from "@/lib/platform/api-keys";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
import { getOrganizationByProjectId } from "@/lib/platform/identity/queries";
import { organizations } from "@/lib/platform/identity/schema";
import { getLogger } from "@/lib/platform/logger";
import { createApiKey, findActiveApiKeyByHash, touchApiKey } from "@/lib/platform/projects/queries";

const logger = getLogger("scripts/seed");
const PROJECT_NAME = "Site Copilot";
const DEFAULT_SLUG = "site-copilot";
const KEY_NAME = "site-copilot-seed";
const MINUTE_MS = 60_000;
const BACKFILL_CHUNK = 500;

interface Args {
  org?: string;
  slug: string;
  anchorMs: number;
  turns: number;
  seed: number;
}

function parseArgs(argv: readonly string[]): Args {
  const valued = new Set(["--slug", "--anchor", "--turns", "--seed"]);
  const valueOf = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const unknown = argv.filter((arg) => arg.startsWith("--") && !valued.has(arg));
  if (unknown.length > 0) throw new Error(`unknown flag ${unknown[0]}; see the header of scripts/seed.mts`);
  const anchorArg = valueOf("--anchor");
  const anchorMs = anchorArg ? new Date(anchorArg).getTime() : Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
  if (!Number.isFinite(anchorMs)) throw new Error(`--anchor is not a date: ${anchorArg}`);
  const turns = Number(valueOf("--turns") ?? SITE_COPILOT_TURNS);
  const seed = Number(valueOf("--seed") ?? SITE_COPILOT_SEED);
  if (!Number.isInteger(turns) || turns < 1) throw new Error("--turns takes a positive integer");
  if (!Number.isInteger(seed)) throw new Error("--seed takes an integer");
  return {
    org: argv.find((arg, i) => !arg.startsWith("--") && !valued.has(argv[i - 1] ?? "")),
    slug: valueOf("--slug") ?? DEFAULT_SLUG,
    anchorMs,
    turns,
    seed,
  };
}

/** The seed's own key, created fresh with the project. */
async function createSeedKey(projectId: string): Promise<string> {
  const key = generateApiKey();
  await createApiKey({ projectId, name: KEY_NAME, keyHash: key.hash, keyPrefix: key.prefix });
  return key.plaintext;
}

/**
 * The traces route handler in-process, wired as `app/api/v1/traces/route.ts`
 * wires it, minus the ingest analytics (a seed is not customer traffic).
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
  });
  if (response.status !== 202) throw new Error(`ingest returned ${response.status}`);
  const counts = (await response.json()) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(counts).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );
}

/**
 * Point each model call's `events` row at its trace and span, so a captured
 * reply joins its turn. Until OTLP ingest writes them this fills them for the
 * seed's own rows (matched by the dedupe hash ingest gives a response id), and
 * once ingest does, it finds nothing to fill. Null when the database predates
 * the columns.
 */
async function fillEventTraceIds(projectId: string, chats: readonly SiteChatSpan[]): Promise<number | null> {
  const db = getDb();
  const columns = await db.execute(
    sql`select 1 from information_schema.columns where table_name = 'events' and column_name = 'trace_id'`,
  );
  if (columns.rows.length === 0) return null;
  let filled = 0;
  for (let i = 0; i < chats.length; i += BACKFILL_CHUNK) {
    const values = sql.join(
      chats.slice(i, i + BACKFILL_CHUNK).map((chat) => sql`(${chatDedupeHash(chat.responseId)}, ${chat.traceId}, ${chat.spanId})`),
      sql`, `,
    );
    const result = await db.execute(sql`
      update events as e set trace_id = v.trace_id, span_id = v.span_id
      from (values ${values}) as v(dedupe_hash, trace_id, span_id)
      where e.project_id = ${projectId} and e.dedupe_hash = v.dedupe_hash and e.trace_id is null`);
    filled += result.rowCount ?? 0;
  }
  return filled;
}

async function storedCounts(
  projectId: string,
): Promise<{ events: number; spans: number; traceEvents: Record<string, number> }> {
  const db = getDb();
  const [events] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from events where project_id = ${projectId}`))
    .rows;
  const [spans] = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from otel_spans where project_id = ${projectId}`)
  ).rows;
  const types = await db.execute<{ type: string; n: number }>(
    sql`select type, count(*)::int as n from trace_events where project_id = ${projectId} group by type order by type`,
  );
  return {
    events: events?.n ?? 0,
    spans: spans?.n ?? 0,
    traceEvents: Object.fromEntries(types.rows.map((row) => [row.type, row.n])),
  };
}

async function seed() {
  assertLocalDatabase("seed Site Copilot");
  const args = parseArgs(process.argv.slice(2));
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
  const filled = await fillEventTraceIds(project.id, rendered.chatSpans);
  return { org, windowDays, project, plan, rendered, accepted, filled, stored: await storedCounts(project.id) };
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
    `   stored: events ${stored.events}, otel_spans ${stored.spans}, trace_events ${Object.entries(stored.traceEvents)
      .map(([type, n]) => `${type} ${n}`)
      .join(", ")}`,
    out.filled === null
      ? "   events.trace_id: this database predates the trace_id columns, so replies cannot be joined to turns"
      : `   events.trace_id: filled on ${out.filled} model-call rows`,
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
