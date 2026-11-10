import { replaceProject } from "@/lib/console/seed/replace-project";
import { siteCopilotCatalogEntries } from "@/lib/console/seed/site-copilot-catalog";
import { renderSiteCopilotOtlp, SITE_COPILOT_DAYS } from "@/lib/console/seed/site-copilot-otlp";
import {
  planSiteCopilot,
  SITE_COPILOT_SEED,
  SITE_COPILOT_TURNS,
} from "@/lib/console/seed/site-copilot-plan";
import { insertEventsWithMetrics, insertOtelSpans } from "@/lib/ingest/otlp/queries";
import { handleTracesRequest } from "@/lib/ingest/otlp/route-handler";
import { findRuntimeInvokes } from "@/lib/ingest/otlp/runtime-facts-query";
import { upsertRuntimeCatalogEntries } from "@/lib/ingest/runtime-catalog/queries";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { enqueueBuildTraceTurnsJob } from "@/lib/ledger/turns/queries";
import { generateApiKey, hashApiKey } from "@/lib/platform/api-keys";
import { getDb } from "@/lib/platform/db/client";
import { getOrganizationById } from "@/lib/platform/organizations";
import {
  createApiKey,
  findActiveApiKeyByHash,
  getProjectById,
} from "@/lib/platform/projects/queries";
import { enqueueClusterIntentsJob } from "@/lib/readings/intent-engine/jobs";
import { enqueueFoldIntentGraphJob } from "@/lib/readings/intent-graph/queries";

/**
 * Seed "Site Copilot" into an organization: a general contractor's field assistant, sent the
 * way an agent that exports OpenTelemetry with content capture on sends it (the traces route
 * handler in-process, GenAI semantic conventions, API-key auth), and nothing else: the same
 * history upstream's seed sends. The scenario is described in `site-copilot-plan.ts` and
 * `site-copilot-turns.ts`.
 *
 * Idempotent: the project is deleted (with everything it owns) and created again under the
 * same id before anything is sent. Nothing is drained here: the ledger build is enqueued the
 * way the route enqueues it, and the caller decides when the jobs run (`scripts/seed.mts`
 * runs drain ticks; the sample provisioner schedules a drain after the response).
 */

export const SITE_COPILOT_PROJECT_NAME = "Site Copilot";
export const SITE_COPILOT_SLUG = "site-copilot";
const KEY_NAME = "site-copilot-seed";

export interface SeedSiteCopilotInput {
  organizationId: string;
  slug?: string;
  /** The end of the thirty-day window, in epoch milliseconds; now by default. */
  anchorMs?: number;
  /** Turns to plan; the plan's default is the full demo. */
  turns?: number;
  /** The plan's seed, so every run plans the same conversations. */
  seed?: number;
}

export interface SeededSiteCopilot {
  projectId: string;
  projectSlug: string;
  /** Whether an earlier copy was deleted first. */
  replaced: boolean;
  /** What the traces route accepted, by kind. */
  accepted: Record<string, number>;
  skills: number;
  traces: number;
  spans: number;
  /** The plan and what was rendered, for a report. */
  plan: ReturnType<typeof planSiteCopilot>;
  rendered: ReturnType<typeof renderSiteCopilotOtlp>;
}

type SeedDb = ReturnType<typeof getDb>;

/** The seed's own key, created fresh with the project. */
async function createSeedKey(projectId: string, db: SeedDb): Promise<string> {
  const key = generateApiKey();
  await createApiKey({ projectId, name: KEY_NAME, keyHash: key.hash, keyPrefix: key.prefix }, db);
  return key.plaintext;
}

/**
 * The traces route handler in-process, wired as `app/api/v1/traces/route.ts` wires it on the
 * given database, minus the ingest analytics and the key's last-used stamp (a seed is not
 * customer traffic) and the post-response drain (the caller drains, or schedules one, once
 * everything is sent).
 */
async function send(apiKey: string, body: object, db: SeedDb): Promise<Record<string, number>> {
  const request = new Request("http://seed.local/v1/traces", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await handleTracesRequest(request, {
    isDbConfigured: () => true,
    hashApiKey,
    findActiveApiKeyByHash: (hash) => findActiveApiKeyByHash(hash, undefined, db),
    touchApiKey: async () => {},
    insertEventsWithMetrics: (projectId, rows) => insertEventsWithMetrics(projectId, rows, db),
    insertOtelSpans: (projectId, rows) => insertOtelSpans(projectId, rows, db),
    insertTraceEvents: (projectId, events) => insertTraceEvents(projectId, events, db),
    getOrganizationByProjectId: async (projectId) => {
      const project = await getProjectById(projectId, db);
      return project ? getOrganizationById(project.organizationId) : null;
    },
    traceTurns: {
      enqueueBuild: (projectId) => enqueueBuildTraceTurnsJob(projectId, db),
      scheduleProjectDrain: () => {},
    },
    // The readings' first run for a project comes from this ingest kick (the drain's
    // safety net only revisits projects it has met), so the seed queues them like the route.
    enqueueFoldIntentGraphJob: (projectId, _payload, options) =>
      enqueueFoldIntentGraphJob(projectId, db, options),
    enqueueClusterIntentsJob: (projectId, _payload, options) =>
      enqueueClusterIntentsJob(projectId, db, options),
    scheduleProjectDrain: () => {},
    findRuntimeInvokes: (projectId, probe) => findRuntimeInvokes(projectId, probe, db),
  });
  if (response.status !== 202) throw new Error(`ingest returned ${response.status}`);
  const counts = (await response.json()) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(counts).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
}

export async function seedSiteCopilot(
  input: SeedSiteCopilotInput,
  db: SeedDb = getDb(),
): Promise<SeededSiteCopilot> {
  const slug = input.slug ?? SITE_COPILOT_SLUG;
  const anchorMs = input.anchorMs ?? Date.now();
  const project = await replaceProject(db, {
    organizationId: input.organizationId,
    slug,
    name: SITE_COPILOT_PROJECT_NAME,
    isDemo: true,
  });
  const catalog = siteCopilotCatalogEntries(project.id, new Date(anchorMs));
  await upsertRuntimeCatalogEntries(catalog, "events", db);
  const apiKey = await createSeedKey(project.id, db);

  const plan = planSiteCopilot({
    seed: input.seed ?? SITE_COPILOT_SEED,
    turns: input.turns ?? SITE_COPILOT_TURNS,
  });
  const rendered = renderSiteCopilotOtlp(plan, { anchorMs, days: SITE_COPILOT_DAYS });
  const accepted: Record<string, number> = {};
  for (const body of rendered.batches) {
    for (const [key, n] of Object.entries(await send(apiKey, body, db))) {
      accepted[key] = (accepted[key] ?? 0) + n;
    }
  }
  // The page's "read now": a build that, once caught up, enqueues the signal run.
  await enqueueBuildTraceTurnsJob(project.id, db, { reading: "manual" });
  return {
    projectId: project.id,
    projectSlug: slug,
    replaced: project.replaced,
    accepted,
    skills: catalog.filter((entry) => entry.kind === "skill").length,
    traces: rendered.stats.traces,
    spans: rendered.stats.spans,
    plan,
    rendered,
  };
}
