import { z } from "zod";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { invalidParams, McpOperationError, notFound } from "@/lib/mcp/errors";
import {
  type ContentAccessDeps,
  contentHint,
  mayReadContent,
  readContentOptIn,
  withheldMarker,
} from "@/lib/mcp/operations/content-access";
import { projectScoped, uuidParam } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation, type OperationContext } from "@/lib/mcp/registry";
import { capRows, limitParam, round, TruncationTracker } from "@/lib/mcp/serialize";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { checkMeteredFeature, type FeatureAccess } from "@/lib/platform/entitlements";
import { getLogger } from "@/lib/platform/logger";
import type { Organization } from "@/lib/platform/organizations";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { getProjectById } from "@/lib/platform/projects/queries";
import type { Project } from "@/lib/platform/projects/schema";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { getRuntimeCatalogOverrideAdoption } from "@/lib/synthesis/catalog/runtime-reads";
import type { RangePreset } from "@/lib/synthesis/dashboard";
import {
  type ApplyDeps,
  type ApplyOutcome,
  applyProposal,
  applyProposals,
  dismissProposal,
  revertProposal,
} from "@/lib/synthesis/match-quality/apply";
import { applyFailureMessage, liveApplyDeps } from "@/lib/synthesis/match-quality/apply-deps";
import { countRunsSince, getLatestRun, listProposals } from "@/lib/synthesis/match-quality/queries";
import type {
  MatchQualityProposalRow,
  MatchQualityRunRow,
} from "@/lib/synthesis/match-quality/schema";
import { isSearchTelemetry } from "@/lib/synthesis/match-quality/search-source";
import { type ManualRunOutcome, startManualRun } from "@/lib/synthesis/match-quality/start-run";
import { proposalFailures, proposalImpact } from "@/lib/synthesis/match-quality/view";
import { RUN_WINDOW_OPTIONS, startOfBillingPeriod } from "@/lib/synthesis/match-quality/window";
import { entitled } from "@/lib/views/quality/context";
import {
  type RewriteRow,
  rewriteForTool,
  rewriteRows,
  runView,
} from "@/lib/views/quality/descriptions";
import { type Headline, TIER_LABEL } from "@/lib/views/quality/headline";
import { loadProjection, loadToolCard } from "@/lib/views/quality/load-descriptions";
import {
  loadMissRows,
  loadQualityEvidence,
  type QualityEvidence,
} from "@/lib/views/quality/load-misses";
import type { MissRow } from "@/lib/views/quality/miss-rows";
import { EVIDENCE_LABEL, matchesSearch, outcomeOf, rankLabel } from "@/lib/views/quality/misses";
import { resolveQualityWindow } from "@/lib/views/quality/model";
import { budgetLine, runBudgetOf } from "@/lib/views/quality/run-menu";

/**
 * Quality over MCP: the Misses tab (how often the right tool comes first, and
 * the searches where it did not), the Descriptions tab (the searchable
 * description rewrites an analysis drafted, and acting on them), and starting
 * an analysis.
 *
 * Every read is the console's own: the same evidence loader, the same rows,
 * the same plan check (`matchQualityRunsPerMonth`, where a spent allowance
 * still shows what earlier runs found). The writes go through the same apply,
 * dismiss and revert functions as the console's buttons, so a rewrite applied
 * here moves to applied and can be reverted to exactly the text it replaced,
 * which `set_catalog_override` alone cannot do.
 *
 * End users' search text is the bulk of these results, so it is truncated and
 * capped the way `list_search_queries_for_skill` does, returned only to a
 * caller that may read captured text (`mayReadContent`), and a rewrite's
 * missed searches only for the one rewrite or tool asked about, as the console
 * reads them when one rewrite is opened.
 */
const logger = getLogger("mcp/quality");

const QUERY_CHARS = 300;
const DESCRIPTION_CHARS = 1_000;
const RATIONALE_CHARS = 600;
/** Missed searches carried per rewrite; the rest are counted. */
const FAILURES_PER_REWRITE = 5;
const RANKED_SHOWN = 5;

const RANGE_PRESETS = ["7d", "14d", "30d", "3m", "12m"] as const satisfies readonly RangePreset[];

const rangeParam = z
  .enum(RANGE_PRESETS)
  .default("7d")
  .describe(
    "The window, as the console's presets: 7d, 14d, 30d, 3m or 12m. Compared with the window before it.",
  );

export interface QualityOperationDeps extends ContentAccessDeps {
  getOrganizationByProjectId: (projectId: string) => Promise<Organization | null>;
  /** The run's analyst prompt names the project. */
  getProjectById: (projectId: string) => Promise<Pick<Project, "id" | "name"> | null>;
  countRunsSince: (projectId: string, since: Date) => Promise<number>;
  getLatestRun: (projectId: string) => Promise<MatchQualityRunRow | null>;
  listProposals: (
    projectId: string,
    options?: { statuses?: readonly string[] },
  ) => Promise<MatchQualityProposalRow[]>;
  loadQualityEvidence: typeof loadQualityEvidence;
  loadMissRows: typeof loadMissRows;
  loadProjection: typeof loadProjection;
  loadToolCard: typeof loadToolCard;
  /** Whether a runtime fetched the catalog overrides recently; null is no evidence either way. */
  getOverrideAdoption: (projectId: string) => Promise<boolean | null>;
  applyDeps: () => ApplyDeps;
  applyProposal: typeof applyProposal;
  applyProposals: typeof applyProposals;
  dismissProposal: typeof dismissProposal;
  revertProposal: typeof revertProposal;
  startManualRun: (input: Parameters<typeof startManualRun>[0]) => Promise<ManualRunOutcome>;
  trackServerEvent: typeof trackServerEvent;
  now?: () => Date;
}

export const defaultQualityDeps: QualityOperationDeps = {
  getOrganizationByProjectId,
  getProjectById: (projectId) => getProjectById(projectId),
  countRunsSince: (projectId, since) => countRunsSince(projectId, since),
  getLatestRun: (projectId) => getLatestRun(projectId),
  listProposals: (projectId, options) => listProposals(projectId, options),
  loadQualityEvidence,
  loadMissRows,
  loadProjection,
  loadToolCard,
  getOverrideAdoption: (projectId) =>
    withStatementTimeout((db) => getRuntimeCatalogOverrideAdoption(projectId, db), {
      operation: "mcp_quality_override_adoption",
    }),
  applyDeps: liveApplyDeps,
  applyProposal,
  applyProposals,
  dismissProposal,
  revertProposal,
  startManualRun: (input) => startManualRun(input),
  trackServerEvent,
  contentOptIn: readContentOptIn,
};

/** Who acted, as the stored rows and events name them. */
function actorOf(auth: McpAuthContext, projectId: string): string {
  return auth.kind === "api-key" ? `project:${projectId}` : auth.externalUserId;
}

function eventContext(ctx: OperationContext) {
  const orgId = ctx.organizationId ? { orgId: ctx.organizationId } : {};
  return ctx.auth.kind === "api-key"
    ? { projectId: ctx.projectId, ...orgId }
    : { externalId: ctx.auth.externalUserId, projectId: ctx.projectId, ...orgId };
}

interface Access {
  organization: Organization;
  access: FeatureAccess;
}

/** Match quality's plan check, as the Quality page runs it. */
async function planAccess(
  deps: QualityOperationDeps,
  projectId: string,
  now: Date,
): Promise<Access> {
  const organization = await deps.getOrganizationByProjectId(projectId);
  if (!organization) throw notFound("project");
  const used = await deps.countRunsSince(projectId, startOfBillingPeriod(now));
  return {
    organization,
    access: checkMeteredFeature(organization, "matchQualityRunsPerMonth", used, "Match quality"),
  };
}

/** The Quality page's gate: on the plan, even with this period's runs spent. */
async function requireEntitled(
  deps: QualityOperationDeps,
  projectId: string,
  now: Date,
): Promise<Access> {
  const result = await planAccess(deps, projectId, now);
  if (!entitled({ access: result.access })) {
    const message = result.access.ok ? "" : result.access.message;
    throw new McpOperationError("forbidden", message, { reason: "not_on_plan" });
  }
  return result;
}

function headlineView(headline: Headline) {
  return {
    tier: headline.tier,
    tierLabel: headline.tier ? TIER_LABEL[headline.tier] : null,
    searches: headline.n,
    hits: headline.hits,
    share: round(headline.share),
    change: headline.change,
    trend: headline.trend.map((value) => round(value)),
    trendUnit: headline.trendUnit,
  };
}

/** The trace id at the end of a miss row's trace link; null when the trace was not kept. */
function traceIdOf(href: string | null): string | null {
  if (!href) return null;
  const segment = href.slice(href.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function missView(
  row: MissRow,
  evidence: QualityEvidence,
  tracker: TruncationTracker,
  content: boolean,
) {
  const experiment = evidence.source.kind === "experiment";
  return {
    query: !content || row.query === null ? null : tracker.text(row.query, QUERY_CHARS),
    rightTool: row.expected,
    rank: row.rank,
    rankLabel: rankLabel(row.rank),
    outcome: outcomeOf(row.rank),
    rankedFirst: row.rankedFirst,
    evidence: EVIDENCE_LABEL[row.evidence],
    count: row.count,
    lastSeen: row.lastSeen,
    traceId: traceIdOf(row.traceHref),
    // An experiment selection reopens with get_selection; a plain search has no selection to open.
    selectionId: experiment ? row.id : null,
    ourTop: row.ours.items.slice(0, RANKED_SHOWN),
    ...(row.comparison
      ? { theirRank: row.comparisonRank, theirTop: row.comparison.items.slice(0, RANKED_SHOWN) }
      : {}),
    rewrite: row.rewrite,
  };
}

/** Whether a rewrite's missed searches are listed, and whether their words may be read. */
interface MissedAccess {
  listed: boolean;
  content: boolean;
}

/** The searches a rewrite missed: end users' words, so few and short, and only for the rewrite asked about. */
function missedView(
  proposal: MatchQualityProposalRow | undefined,
  tracker: TruncationTracker,
  content: boolean,
) {
  const failures = proposal ? proposalFailures(proposal.evidence) : [];
  const listed = capRows(failures, FAILURES_PER_REWRITE);
  tracker.mark(listed.truncated);
  const lost = proposal ? proposalImpact(proposal).lost : listed.rows.length;
  return {
    missed: listed.rows.map((failure) => ({
      query: !content || failure.query === null ? null : tracker.text(failure.query, QUERY_CHARS),
      selectionId: failure.selectionId ?? null,
      rankedFirst: failure.ourTop,
    })),
    moreMissed: Math.max(0, lost - listed.rows.length),
  };
}

function rewriteView(
  row: RewriteRow,
  proposal: MatchQualityProposalRow | undefined,
  tracker: TruncationTracker,
  access: MissedAccess,
) {
  return {
    proposalId: row.id,
    status: row.status,
    toolId: row.toolId,
    toolName: row.toolName,
    change: row.change,
    missedSearches: row.missed,
    effect: row.effect,
    createdAt: row.createdAt,
    appliedAt: row.appliedAt,
    currentSearchableDescription: tracker.text(row.before, DESCRIPTION_CHARS),
    proposedSearchableDescription: tracker.text(row.after, DESCRIPTION_CHARS),
    rationale: tracker.text(row.rationale, RATIONALE_CHARS),
    ...(access.listed ? missedView(proposal, tracker, access.content) : {}),
  };
}

function rewritesHint(
  pending: number,
  overridesAdopted: boolean | null,
  narrowed: boolean,
): string {
  const lead =
    pending > 0
      ? "Apply one with review_description_rewrite (action apply, proposalId), or every pending one with action apply_all. Revert an applied one with action revert."
      : overridesAdopted === false
        ? "No runtime has fetched the catalog overrides recently, so applied rewrites may not reach the agent yet."
        : "Nothing waiting. run_quality_analysis drafts new rewrites from recent searches.";
  return narrowed
    ? lead
    : `${lead} missedSearches counts each rewrite's misses; pass proposalId to list them.`;
}

const ACTION_EVENT = {
  apply: "match_quality_proposal_applied",
  dismiss: "match_quality_proposal_dismissed",
  revert: "match_quality_proposal_reverted",
} as const;

function refuse(outcome: Exclude<ApplyOutcome, { ok: true }>): McpOperationError {
  if (outcome.reason === "not_found") return notFound("description rewrite");
  return new McpOperationError("conflict", applyFailureMessage(outcome.reason), {
    reason: outcome.reason,
  });
}

export function qualityOperations(deps: QualityOperationDeps = defaultQualityDeps): McpOperation[] {
  const now = () => deps.now?.() ?? new Date();

  return [
    defineOperation({
      id: "get_quality",
      domain: "improvement",
      title: "Quality: misses",
      description:
        "How often search put the right tool first over a window, the change vs the window before, the customer's own ranking beside ours, and the searches where it did not (right tool, rank, what came first, how we know). Filter with q or outcome. Fix one with list_description_rewrites.",
      keywords: [
        "quality",
        "misses",
        "right tool first",
        "search quality",
        "headline",
        "missed searches",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        range: rangeParam,
        q: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Case-insensitive text matched against the search and both tool names."),
        outcome: z
          .enum(["missing", "lower"])
          .optional()
          .describe("missing: the right tool was not returned. lower: returned, but not first."),
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const at = now();
        await requireEntitled(deps, ctx.projectId, at);
        const window = resolveQualityWindow({ range: params.range }, at);
        const bounds = { since: window.since, until: window.until };
        const [run, proposals] = await Promise.all([
          deps.getLatestRun(ctx.projectId),
          deps.listProposals(ctx.projectId),
        ]);
        const evidence = await deps.loadQualityEvidence({
          projectId: ctx.projectId,
          window: bounds,
          run,
        });
        if (!evidence) {
          throw new McpOperationError(
            "internal",
            "The searches for this window could not be read. Try again shortly.",
          );
        }
        const rows = await deps.loadMissRows({
          projectId: ctx.projectId,
          evidence,
          window: bounds,
          proposals,
        });
        const content = rows.length > 0 ? await mayReadContent(ctx, deps) : true;
        // Withheld, q matches the tool names only: matching the search would read it back a guess at a time.
        const matching = rows.filter(
          (row) =>
            (params.outcome === undefined || outcomeOf(row.rank) === params.outcome) &&
            (params.q === undefined ||
              matchesSearch(
                {
                  query: content ? row.query : null,
                  rankedFirstName: row.rankedFirst?.name ?? null,
                  expectedName: row.expected.name,
                },
                params.q,
              )),
        );

        const tracker = new TruncationTracker();
        const page = capRows(matching, params.limit);
        tracker.mark(page.truncated);
        // The loader lists at most this many; more misses than that is a cut too.
        tracker.mark(evidence.missCount > rows.length);
        const theirs = evidence.theirs;
        return {
          data: {
            window: { range: window.preset, label: window.label },
            source: evidence.source,
            searches: evidence.searches,
            answered: evidence.answered,
            rankedFirst: headlineView(evidence.headline),
            found: headlineView(evidence.found),
            theirs: theirs
              ? {
                  variant: theirs.arm,
                  served: theirs.served,
                  rankedFirst: headlineView(theirs.first),
                  found: headlineView(theirs.found),
                }
              : null,
            ...(evidence.cut ? { cut: { readLimit: evidence.readLimit } } : {}),
            missCount: evidence.missCount,
            matching: matching.length,
            misses: page.rows.map((row) => missView(row, evidence, tracker, content)),
            ...withheldMarker(content),
          },
          truncated: tracker.value,
          window: { since: window.since.toISOString(), until: window.until.toISOString() },
          hint: contentHint(
            content,
            evidence.headline.tier === null
              ? "No search here has a known right tool yet. Start an analysis with run_quality_analysis to judge them."
              : "list_description_rewrites shows the rewrites drafted for these tools; test_retrieval reproduces one search; get_selection opens one by selectionId.",
          ),
        };
      },
    }),
    defineOperation({
      id: "list_description_rewrites",
      domain: "improvement",
      title: "Quality: description rewrites",
      description:
        "The searchable-description rewrites waiting and applied: current vs proposed text, why, what a replay of past searches says each does, all pending ones together, and whether a runtime picks overrides up. Pass proposalId for one rewrite's missed searches, or tool for one tool's card. Act with review_description_rewrite.",
      keywords: [
        "descriptions",
        "rewrites",
        "pending rewrites",
        "proposals",
        "apply",
        "override adoption",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        tool: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "A tool's catalog entry id (toolId here, rightTool.id in get_quality): only its rewrites, with their missed searches, and its card.",
          ),
        proposalId: uuidParam()
          .optional()
          .describe("Only this rewrite, with the searches it missed."),
        range: rangeParam.describe("The window the tool card's search counts cover."),
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const at = now();
        await requireEntitled(deps, ctx.projectId, at);
        const [run, proposals] = await Promise.all([
          deps.getLatestRun(ctx.projectId),
          deps.listProposals(ctx.projectId),
        ]);
        const rows = rewriteRows(proposals);
        const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
        const forTool = (list: RewriteRow[]) =>
          list.filter(
            (row) =>
              (params.tool === undefined || row.toolId === params.tool) &&
              (params.proposalId === undefined || row.id === params.proposalId),
          );
        if (
          params.proposalId !== undefined &&
          forTool([...rows.pending, ...rows.applied]).length === 0
        ) {
          throw notFound("description rewrite");
        }
        // Missed searches are end users' words: listed only for the one rewrite or tool asked about.
        const narrowed = params.proposalId !== undefined || params.tool !== undefined;
        const access: MissedAccess = {
          listed: narrowed,
          content: narrowed ? await mayReadContent(ctx, deps) : true,
        };

        const card = async () => {
          if (params.tool === undefined) return null;
          const window = resolveQualityWindow({ range: params.range }, at);
          const evidence = await deps.loadQualityEvidence({
            projectId: ctx.projectId,
            window: { since: window.since, until: window.until },
            run,
          });
          return deps.loadToolCard(ctx.projectId, params.tool, evidence);
        };
        const [projection, overridesAdopted, tool] = await Promise.all([
          deps.loadProjection(ctx.projectId, run, proposals),
          deps.getOverrideAdoption(ctx.projectId).catch((error: unknown) => {
            // A missing adoption reading costs one field, never the list.
            logger.warn({ err: error, project_id: ctx.projectId }, "override adoption read failed");
            return null;
          }),
          card(),
        ]);

        const tracker = new TruncationTracker();
        const pending = tracker.take(capRows(forTool(rows.pending), params.limit));
        const applied = tracker.take(capRows(forTool(rows.applied), params.limit));
        return {
          data: {
            run: runView(run),
            experimentName:
              run && !isSearchTelemetry(run.experimentName) ? run.experimentName : null,
            pendingCount: forTool(rows.pending).length,
            appliedCount: forTool(rows.applied).length,
            pending: pending.map((row) => rewriteView(row, byId.get(row.id), tracker, access)),
            applied: applied.map((row) => rewriteView(row, byId.get(row.id), tracker, access)),
            projection,
            overridesAdopted,
            ...(params.tool !== undefined
              ? {
                  tool: tool
                    ? {
                        id: tool.id,
                        name: tool.name,
                        searchableDescription: tracker.text(tool.description, DESCRIPTION_CHARS),
                        source: tool.source,
                        tally: tool.tally,
                      }
                    : null,
                  toolRewrite:
                    rewriteForTool([...rows.pending, ...rows.applied], params.tool)?.id ?? null,
                }
              : {}),
            ...withheldMarker(access.content),
          },
          truncated: tracker.value,
          hint: contentHint(
            access.content,
            rewritesHint(rows.pending.length, overridesAdopted, narrowed),
          ),
        };
      },
    }),
    defineOperation({
      id: "review_description_rewrite",
      domain: "writes",
      title: "Apply, dismiss or revert a description rewrite",
      description:
        "Act on a searchable-description rewrite from list_description_rewrites: apply writes its text as the catalog override, dismiss closes it, revert restores the exact text it replaced, apply_all applies every pending one. Prefer this to set_catalog_override for a drafted rewrite.",
      keywords: [
        "apply rewrite",
        "dismiss",
        "revert",
        "undo",
        "searchable description",
        "apply all",
      ],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        action: z.enum(["apply", "dismiss", "revert", "apply_all"]),
        proposalId: uuidParam()
          .optional()
          .describe(
            "The rewrite's proposalId. Required for apply, dismiss and revert; ignored by apply_all.",
          ),
      }),
      async execute(ctx, params) {
        const applyDeps = deps.applyDeps();
        if (params.action === "apply_all") {
          const waiting = await deps.listProposals(ctx.projectId, { statuses: ["pending"] });
          if (waiting.length === 0) {
            return { data: { applied: [], failed: [] }, hint: "Nothing left to apply." };
          }
          const outcome = await deps.applyProposals(
            ctx.projectId,
            waiting.map((row) => row.id),
            actorOf(ctx.auth, ctx.projectId),
            applyDeps,
          );
          await deps.trackServerEvent("match_quality_proposal_applied", eventContext(ctx), {
            object_action: "match_quality_proposal_applied",
            bulk: true,
            applied: outcome.applied.length,
            failed: outcome.failed.length,
            surface: "mcp",
          });
          return {
            data: { applied: outcome.applied, failed: outcome.failed },
            hint:
              outcome.failed.length === 0
                ? `Applied ${outcome.applied.length}. Revert any one with action revert and its proposalId.`
                : `Applied ${outcome.applied.length}. ${outcome.failed.length} could not be applied and are still listed.`,
          };
        }

        const proposalId = params.proposalId;
        if (!proposalId) throw invalidParams(`proposalId is required for action ${params.action}.`);
        const outcome =
          params.action === "apply"
            ? await deps.applyProposal(
                ctx.projectId,
                proposalId,
                actorOf(ctx.auth, ctx.projectId),
                applyDeps,
              )
            : params.action === "dismiss"
              ? await deps.dismissProposal(ctx.projectId, proposalId, applyDeps)
              : await deps.revertProposal(ctx.projectId, proposalId, applyDeps);
        if (!outcome.ok) throw refuse(outcome);

        const event = ACTION_EVENT[params.action];
        await deps.trackServerEvent(event, eventContext(ctx), {
          object_action: event,
          proposal_id: proposalId,
          ...(params.action === "apply" ? { bulk: false } : {}),
          surface: "mcp",
        });
        return {
          data: { proposalId, status: outcome.status },
          hint:
            params.action === "apply"
              ? "The override is written. Undo with action revert; it restores the text this replaced."
              : params.action === "revert"
                ? "The tool is back to its previous searchable description."
                : "Dismissed. A later analysis may draft a new rewrite for this tool.",
        };
      },
    }),
    defineOperation({
      id: "run_quality_analysis",
      domain: "writes",
      title: "Start a quality analysis",
      description:
        "Queue a match quality analysis of the last 7, 14 or 30 days of searches: it judges which tool was right and drafts description rewrites. Counts against the plan's monthly runs. Returns the job id to poll with get_job_status, then read list_description_rewrites.",
      keywords: [
        "analyse searches",
        "run analysis",
        "match quality run",
        "judge",
        "draft rewrites",
      ],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        windowDays: z
          .number()
          .int()
          .refine((days) => RUN_WINDOW_OPTIONS.includes(days), {
            message: "windowDays must be 7, 14 or 30.",
          })
          .default(7)
          .describe("Days of searches to analyse: 7, 14 or 30."),
      }),
      async execute(ctx, params) {
        const at = now();
        const [project, organization] = await Promise.all([
          deps.getProjectById(ctx.projectId),
          deps.getOrganizationByProjectId(ctx.projectId),
        ]);
        if (!project || !organization) throw notFound("project");
        // The plan check lives inside startManualRun, the same one the console's button runs.
        const outcome = await deps.startManualRun({
          project: { id: project.id, name: project.name },
          organization,
          windowDaysRaw: params.windowDays,
        });
        if (!outcome.ok) {
          if (outcome.reason === "quota") {
            throw new McpOperationError("quota_exceeded", outcome.message, {
              reason:
                outcome.access.reason === "exhausted" ? "matchQualityRunsPerMonth" : "not_on_plan",
            });
          }
          if (outcome.reason === "no_source") {
            throw new McpOperationError("conflict", outcome.message, { reason: "no_searches" });
          }
          if (outcome.reason === "window_unsupported") throw invalidParams(outcome.message);
          throw new McpOperationError("internal", outcome.message);
        }
        if (outcome.status === "already_running") {
          return {
            data: { started: false, windowDays: outcome.windowDays, message: outcome.message },
            hint: "Call get_job_status without a jobId to follow the run already in flight.",
          };
        }

        await deps.trackServerEvent("match_quality_run_started", eventContext(ctx), {
          object_action: "match_quality_run_started",
          trigger: "manual",
          window_days: outcome.windowDays,
          surface: "mcp",
        });
        const after = checkMeteredFeature(
          organization,
          "matchQualityRunsPerMonth",
          outcome.access.used + 1,
          "Match quality",
        );
        const remaining = after.ok ? after.remaining : 0;
        return {
          data: {
            started: true,
            runId: outcome.run.id,
            jobId: outcome.jobId,
            windowDays: outcome.windowDays,
            runsLeftThisMonth: Number.isFinite(remaining) ? remaining : null,
            allowance: budgetLine(runBudgetOf(after, at)),
          },
          hint: "Poll get_job_status with this jobId. When it finishes, list_description_rewrites shows what it drafted and get_quality the judged numbers.",
        };
      },
    }),
  ];
}
