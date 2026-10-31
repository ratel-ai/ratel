/**
 * Seed Match quality for Site Copilot, so Quality's Misses, Descriptions and
 * Experiments show a month of a real-looking customer:
 *
 *   - the agent's tool searches: each ask, ranked by the customer's own keyword
 *     search (the `legacy` variant, which the agent is shown) and by Ratel
 *     beside it (`ratel`), sent as the SDK's `ratel.experiment.*` records
 *     through the real OTLP logs handler, with the project's own seed key;
 *   - the answer key a judge leaves: the tool each ask needed, a few asks no
 *     tool answers left unclear, and some not read yet;
 *   - two weekly runs of Match quality's own pipeline, two weeks apart, with
 *     their replay: after the first, one rewrite was applied (its tool is found
 *     from then on) and one dismissed; the latest has rewrites waiting.
 *
 *   pnpm --filter @ratel/platform seed:quality                # site-copilot of the operator's organization, on $DATABASE_URL
 *   pnpm --filter @ratel/platform seed:quality --capture      # draft the rewrites with the real analyst first
 *   DATABASE_URL=... pnpm --filter @ratel/platform seed:quality [org-slug] [--slug <slug>] [--capture]
 *
 * Needs the Site Copilot project (`pnpm --filter @ratel/platform seed`): it reads when
 * each stored turn happened. Deterministic and idempotent: everything Match
 * quality holds for the project (runs, rewrites, the answer key, the
 * experiment's records and tags, applied rewrites) is taken out and written
 * again the same way. The rewrites are a real analyst's answers, captured in
 * `lib/console/seed/site-copilot-quality-fixture.ts` and replayed (runs are stored as
 * mocked); `--capture` asks the real analyst again (ANTHROPIC_API_KEY, a model
 * call per run) and rewrites that file. No other model is called.
 *
 * Refuses a database that is not on this machine. Prints counts, never text.
 */
import { writeFileSync } from "node:fs";
import { config } from "dotenv";
import { and, eq } from "drizzle-orm";
import { assertLocalDatabase } from "@/lib/console/seed/local-database";
import { resolveSeedOrganization } from "@/lib/console/seed/replace-project";
import {
  planSiteCopilot,
  SITE_COPILOT_SEED,
  SITE_COPILOT_TURNS,
} from "@/lib/console/seed/site-copilot-plan";
import {
  APPLIED_AFTER_EARLIER,
  answerKeyLabels,
  type CapturedRun,
  DISMISSED_AFTER_EARLIER,
  keywordSearch,
  logsExport,
  OURS_DEPTH,
  planQualitySearches,
  qualityTimeline,
  type RunSlot,
  replayAnalyst,
  type SearchSighting,
  SITE_QUALITY_EXPERIMENT,
  searchTime,
  sightingRecords,
  THEIRS_DEPTH,
  withoutEmDashes,
} from "@/lib/console/seed/site-copilot-quality";
import { SITE_QUALITY_CAPTURED } from "@/lib/console/seed/site-copilot-quality-fixture";
import {
  resetSiteQuality,
  rootSpanStarts,
  SITE_COPILOT_KEY_NAME,
  tagExperimentTraces,
} from "@/lib/console/seed/site-copilot-quality-store";
import { handleLogsRequest } from "@/lib/ingest/otlp/logs-route-handler";
import { insertOtelLogs } from "@/lib/ingest/otlp/queries";
import { loadToolCorpus } from "@/lib/ingest/runtime-catalog/inventory";
import { generateApiKey, hashApiKey } from "@/lib/platform/api-keys";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getOrganizationByProjectId } from "@/lib/platform/identity/queries";
import { getLogger } from "@/lib/platform/logger";
import { createApiKey, findActiveApiKeyByHash, touchApiKey } from "@/lib/platform/projects/queries";
import { projects } from "@/lib/platform/projects/schema";
import { identityFingerprint } from "@/lib/readings/decisions/judge";
import {
  type AnalystDeps,
  anthropicAnalystDeps,
  DEFAULT_ANALYST_MODEL,
  parseAnalystResponse,
} from "@/lib/synthesis/match-quality/analyst";
import {
  type ApplyDeps,
  applyProposal,
  dismissProposal,
} from "@/lib/synthesis/match-quality/apply";
import type { AnalystContext } from "@/lib/synthesis/match-quality/context";
import { matchQualityRunDeps } from "@/lib/synthesis/match-quality/job";
import { type PersistInput, runMatchQuality } from "@/lib/synthesis/match-quality/pipeline";
import {
  getProposal,
  listProposals,
  markRunRunning,
  persistFinishedRun,
  startRun,
  swapRuntimeOverride,
  transitionProposal,
  upsertLabels,
} from "@/lib/synthesis/match-quality/queries";
import { bm25Order } from "@/lib/synthesis/match-quality/replay";
import { matchQualityProposals } from "@/lib/synthesis/match-quality/schema";

// The analyst key, read the way the app reads it, for --capture only. Set values win.
config({ path: ".env.local", quiet: true });

const logger = getLogger("scripts/seed-site-copilot-quality");
const DEFAULT_SLUG = "site-copilot";
/** Records per OTLP export: under the handler's cap of 5,000 and its 4 MB body. */
const RECORDS_PER_EXPORT = 1_000;
/** Who applied and dismissed, as `applied_by` stores it. */
const ACTOR = "seed:site-copilot-quality";
const FIXTURE_PATH = "lib/console/seed/site-copilot-quality-fixture.ts";
const MINUTE_MS = 60_000;

type Db = ReturnType<typeof getDb>;
type RunName = "earlier" | "latest";

interface Args {
  org?: string;
  slug: string;
  capture: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const valued = new Set(["--slug"]);
  const unknown = argv.filter(
    (arg) => arg.startsWith("--") && !valued.has(arg) && arg !== "--capture",
  );
  if (unknown.length > 0)
    throw new Error(
      `unknown flag ${unknown[0]}; see the header of scripts/seed-site-copilot-quality.mts`,
    );
  const slugAt = argv.indexOf("--slug");
  return {
    org: argv.find((arg, index) => !arg.startsWith("--") && !valued.has(argv[index - 1] ?? "")),
    slug: slugAt === -1 ? DEFAULT_SLUG : (argv[slugAt + 1] ?? DEFAULT_SLUG),
    capture: argv.includes("--capture"),
  };
}

async function resolveProject(db: Db, args: Args): Promise<{ id: string; name: string }> {
  const org = await resolveSeedOrganization(db, args.org);
  const [project] = await db
    .select({ id: projects.id, name: projects.name, isDemo: projects.isDemo })
    .from(projects)
    .where(and(eq(projects.organizationId, org.id), eq(projects.slug, args.slug)))
    .limit(1);
  if (!project)
    throw new Error(`no project "${args.slug}" in ${org.slug}: run the seed command first`);
  if (!project.isDemo) throw new Error(`refusing to seed "${project.name}": it is not sample data`);
  return project;
}

/** The project's seed key, created under the seed's own name if the project lost it. */
async function ingestKey(db: Db, projectId: string): Promise<string> {
  const key = generateApiKey();
  await createApiKey(
    {
      projectId,
      name: SITE_COPILOT_KEY_NAME,
      keyHash: key.hash,
      keyPrefix: key.prefix,
    },
    db,
  );
  return key.plaintext;
}

/** The OTLP logs handler in-process, wired as `app/api/v1/logs/route.ts` wires it, minus analytics. */
async function sendRecords(
  apiKey: string,
  sightings: readonly SearchSighting[],
): Promise<{ accepted: number; records: number }> {
  const records = sightings.flatMap(sightingRecords);
  let accepted = 0;
  for (let offset = 0; offset < records.length; offset += RECORDS_PER_EXPORT) {
    const request = new Request("http://seed.local/v1/logs", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(logsExport(records.slice(offset, offset + RECORDS_PER_EXPORT))),
    });
    const response = await handleLogsRequest(request, {
      isDbConfigured,
      hashApiKey,
      findActiveApiKeyByHash,
      touchApiKey,
      insertOtelLogs,
      getOrganizationByProjectId,
      isPostHogConfigured: () => false,
      getPostHogServer: () => {
        throw new Error("a seed sends no analytics");
      },
    });
    if (response.status !== 202) throw new Error(`log ingest returned ${response.status}`);
    accepted += ((await response.json()) as { accepted?: number }).accepted ?? 0;
  }
  return { accepted, records: records.length };
}

function applyDeps(at: Date): ApplyDeps {
  return { getProposal, swapOverride: swapRuntimeOverride, transitionProposal, now: () => at };
}

/** The analyst for one run: the captured answer, or (capturing) the real model with its answer kept. */
function analystFor(
  run: RunName,
  capture: boolean,
  sink: Partial<Record<RunName, string>>,
): (context: AnalystContext) => AnalystDeps {
  if (!capture) return (context) => replayAnalyst(context, SITE_QUALITY_CAPTURED[run]);
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("--capture needs ANTHROPIC_API_KEY");
  return () => {
    const real = anthropicAnalystDeps(process.env.ANTHROPIC_MODEL || DEFAULT_ANALYST_MODEL);
    return {
      model: real.model,
      complete: async (system, user) => {
        const raw = await real.complete(system, user);
        sink[run] = raw;
        return raw;
      },
    };
  };
}

/** One weekly run, queued, read and finished at its own time, through the pipeline's real collaborators. */
async function executeRun(
  db: Db,
  project: { id: string; name: string },
  slot: RunSlot,
  analyst: (context: AnalystContext) => AnalystDeps,
  mocked: boolean,
) {
  const run = await startRun(
    {
      projectId: project.id,
      experimentName: SITE_QUALITY_EXPERIMENT,
      trigger: "scheduled",
      windowDays: slot.windowDays,
      windowStart: slot.windowStart,
      windowEnd: slot.windowEnd,
    },
    db,
    slot.createdAt,
  );
  if (!run) throw new Error("a match quality run is already live on this project");
  await markRunRunning(run.id, db, new Date(slot.createdAt.getTime() + 2_000));
  const finishedAt = new Date(slot.createdAt.getTime() + 3 * MINUTE_MS);
  const persist = (input: PersistInput) =>
    persistFinishedRun(
      run.id,
      project.id,
      input.items,
      input.proposals,
      {
        census: input.census,
        scores: input.scores,
        observedStages: input.observedStages,
        followThrough: input.followThrough,
        corpusFingerprint: input.corpusFingerprint,
        model: input.model,
        mocked: input.mocked,
        diagnosis: input.diagnosis,
        diagnosisPoints: input.diagnosisPoints,
        declinedReason: input.declinedReason,
        scorer: input.scorer,
        judge: input.judge,
        backtest: input.backtest,
        labels: input.labels,
      },
      db,
      finishedAt,
    );
  const outcome = await runMatchQuality(
    {
      projectId: project.id,
      projectName: project.name,
      experimentName: SITE_QUALITY_EXPERIMENT,
      window: { since: slot.windowStart, until: slot.windowEnd },
      mocked,
    },
    // No judge: the answer key is already written, as a weekly judge leaves it.
    matchQualityRunDeps(analyst, persist, undefined, true),
  );
  return { runId: run.id, outcome };
}

/** After the earlier run: one rewrite applied and one dismissed, a day later. */
async function actOnEarlier(db: Db, projectId: string, runId: string, at: Date) {
  const offered = await listProposals(projectId, { runId, statuses: ["pending"] }, db);
  const applied = offered.find((proposal) => proposal.entryId === APPLIED_AFTER_EARLIER) ?? null;
  const dismissed =
    offered.find((proposal) => proposal.entryId === DISMISSED_AFTER_EARLIER) ?? null;
  if (applied) {
    const outcome = await applyProposal(projectId, applied.id, ACTOR, applyDeps(at));
    if (!outcome.ok) throw new Error(`could not apply ${applied.entryId}: ${outcome.reason}`);
    await db
      .update(matchQualityProposals)
      .set({ updatedAt: at })
      .where(eq(matchQualityProposals.id, applied.id));
  }
  if (dismissed) {
    const outcome = await dismissProposal(projectId, dismissed.id, applyDeps(at));
    if (!outcome.ok) throw new Error(`could not dismiss ${dismissed.entryId}: ${outcome.reason}`);
    await db
      .update(matchQualityProposals)
      .set({ updatedAt: at })
      .where(eq(matchQualityProposals.id, dismissed.id));
  }
  return { applied: applied?.entryId ?? null, dismissed: dismissed?.entryId ?? null };
}

/** The captured answers, as the fixture file holds them, in the console's punctuation. */
function capturedRun(raw: string | undefined, corpusIds: ReadonlySet<string>): CapturedRun {
  if (!raw) return { diagnosis: "", points: [], rewrites: {} };
  const parsed = parseAnalystResponse(raw, corpusIds);
  const plain = withoutEmDashes;
  return {
    diagnosis: plain(parsed.diagnosis.headline),
    points: parsed.diagnosis.points.map((point) => ({
      title: plain(point.title),
      detail: plain(point.detail),
    })),
    rewrites: Object.fromEntries(
      parsed.proposals.map((proposal) => [
        proposal.entryId,
        {
          searchableDescription: plain(proposal.searchableDescription),
          rationale: plain(proposal.rationale),
          details: plain(proposal.details),
          expectedEffect: plain(proposal.expectedEffect),
        },
      ]),
    ),
  };
}

function writeFixture(
  captured: { earlier: CapturedRun; latest: CapturedRun },
  model: string,
): void {
  const body = `import type { CapturedRun } from "@/scripts/site-copilot-quality";

/**
 * The analyst's answers for the Site Copilot quality seed, captured once from a
 * real analysis of the seeded searches (${model}) and replayed on every later
 * run, so the seed stays deterministic and spends nothing. Regenerate with
 * \`pnpm --filter @ratel/platform seed:quality --capture\` (needs ANTHROPIC_API_KEY).
 */
export const SITE_QUALITY_CAPTURED: { earlier: CapturedRun; latest: CapturedRun } = ${JSON.stringify(captured, null, 2)};
`;
  writeFileSync(FIXTURE_PATH, body);
}

async function seed() {
  assertLocalDatabase("seed Site Copilot match quality");
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();
  const project = await resolveProject(db, args);

  const plan = planSiteCopilot({ seed: SITE_COPILOT_SEED, turns: SITE_COPILOT_TURNS });
  const searches = planQualitySearches(plan);
  const starts = await rootSpanStarts(
    project.id,
    searches.map((search) => search.traceId),
    db,
  );
  const placed = searches.filter((search) => starts.has(search.traceId));
  if (placed.length < searches.length * 0.95) {
    throw new Error(
      `only ${placed.length} of ${searches.length} searched turns are stored: run the seed command first`,
    );
  }

  const removed = await resetSiteQuality(project.id, db);
  const apiKey = await ingestKey(db, project.id);
  const before = await loadToolCorpus(project.id, db);
  // The customer's search indexes the tools as their SDK describes them; Cloud's
  // rewrites change only what Ratel matches on.
  const theirs = keywordSearch(
    before.map((entry) => ({ ...entry, searchable: entry.description ?? entry.searchable })),
  );
  const fingerprint = identityFingerprint(before);
  const at = (search: (typeof placed)[number]) => searchTime(starts.get(search.traceId)!);
  const lastAt = new Date(Math.max(...placed.map((search) => at(search).getTime())));
  const timeline = qualityTimeline(lastAt);
  const sink: Partial<Record<RunName, string>> = {};

  // Until the operator acts on the earlier run, Ratel ranks with the catalog as the SDK sent it.
  const oursBefore = bm25Order(before);
  const early = placed
    .filter((search) => at(search) < timeline.actedAt)
    .map(
      (search): SearchSighting => ({
        search,
        at: at(search),
        ours: oursBefore(search.query, OURS_DEPTH),
        theirs: theirs(search.query, THEIRS_DEPTH),
      }),
    );
  const sentEarly = await sendRecords(apiKey, early);
  const earlyLabels = answerKeyLabels(
    early.filter((sighting) => sighting.at < timeline.earlier.windowEnd),
    { judgedAt: new Date(timeline.earlier.createdAt.getTime() - 10 * MINUTE_MS), fingerprint },
  );
  await upsertLabels(project.id, earlyLabels, db, timeline.earlier.createdAt);

  const earlier = await executeRun(
    db,
    project,
    timeline.earlier,
    analystFor("earlier", args.capture, sink),
    !args.capture,
  );
  const acted = await actOnEarlier(db, project.id, earlier.runId, timeline.actedAt);

  // From then on Ratel ranks with the applied rewrite in place.
  const oursAfter = bm25Order(await loadToolCorpus(project.id, db));
  const late = placed
    .filter((search) => at(search) >= timeline.actedAt)
    .map(
      (search): SearchSighting => ({
        search,
        at: at(search),
        ours: oursAfter(search.query, OURS_DEPTH),
        theirs: theirs(search.query, THEIRS_DEPTH),
      }),
    );
  const sentLate = await sendRecords(apiKey, late);
  const known = new Set(earlyLabels.map((label) => label.queryKey));
  const lateLabels = answerKeyLabels(
    [...early.filter((sighting) => sighting.at >= timeline.earlier.windowEnd), ...late],
    { judgedAt: new Date(timeline.latest.createdAt.getTime() - 10 * MINUTE_MS), fingerprint },
  ).filter((label) => !known.has(label.queryKey));
  await upsertLabels(project.id, lateLabels, db, timeline.latest.createdAt);

  const latest = await executeRun(
    db,
    project,
    timeline.latest,
    analystFor("latest", args.capture, sink),
    !args.capture,
  );
  const tagged = await tagExperimentTraces(
    project.id,
    placed.map((search) => search.traceId),
    db,
  );

  if (args.capture) {
    const ids = new Set(before.map((entry) => entry.entryId));
    writeFixture(
      { earlier: capturedRun(sink.earlier, ids), latest: capturedRun(sink.latest, ids) },
      process.env.ANTHROPIC_MODEL || DEFAULT_ANALYST_MODEL,
    );
  }

  const labels = [...earlyLabels, ...lateLabels];
  return {
    project,
    removed,
    searches: placed.length,
    compared: placed.filter((search) => search.fate === "compared").length,
    records: sentEarly.records + sentLate.records,
    accepted: sentEarly.accepted + sentLate.accepted,
    judged: labels.filter((label) => label.source === "judge").length,
    unclear: labels.filter((label) => label.source === "unclear").length,
    timeline,
    runs: { earlier: earlier.outcome, latest: latest.outcome },
    acted,
    tagged,
    captured: args.capture,
  };
}

function report(out: Awaited<ReturnType<typeof seed>>): string {
  const base = (process.env.APP_PUBLIC_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const root = `${base}/project/${out.project.id}/quality`;
  const run = (name: string, outcome: (typeof out.runs)["latest"]) =>
    `   ${name} run: ${outcome.census.selectionsEvaluated} searches scored, ${outcome.candidatesFound} tools nominated, ${outcome.proposalsCreated} rewrites offered, ${outcome.proposalsDiscarded} discarded by the replay${outcome.declinedReason ? ` (declined: ${outcome.declinedReason})` : ""}`;
  return [
    "",
    `seeded match quality for '${out.project.name}' (${out.project.id})`,
    `   reset: ${out.removed.runs} runs, ${out.removed.labels} answers, ${out.removed.logs} records, ${out.removed.spans} tagged turns, ${out.removed.overrides} applied rewrites put back`,
    `   ${out.searches} searches (${out.compared} compared, the rest skipped or dropped): ${out.records} records sent, ${out.accepted} new`,
    `   answer key: ${out.judged} asks judged, ${out.unclear} left unclear`,
    run(`earlier (${out.timeline.earlier.createdAt.toISOString()})`, out.runs.earlier),
    `   then: applied ${out.acted.applied ?? "nothing"}, dismissed ${out.acted.dismissed ?? "nothing"} (${out.timeline.actedAt.toISOString()})`,
    run(`latest (${out.timeline.latest.createdAt.toISOString()})`, out.runs.latest),
    `   ${out.tagged} turns tagged with experiment ${SITE_QUALITY_EXPERIMENT}`,
    out.captured
      ? `   rewrites captured into ${FIXTURE_PATH}`
      : "   rewrites replayed from the captured analysis (runs stored as mocked)",
    "",
    `   ${root}`,
    `   ${root}/descriptions`,
    `   ${root}/experiments`,
    "",
  ].join("\n");
}

seed()
  .then((out) => {
    process.stdout.write(report(out));
    process.exit(0);
  })
  .catch((err: unknown) => {
    logger.error({ err }, "site copilot quality seed failed");
    process.exit(1);
  });
