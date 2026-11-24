import { z } from "zod";
import { composition } from "@/lib/composition/ports";
import { scheduleProjectDrain } from "@/lib/jobs/route-helpers";
import { enqueueBuildTraceTurnsJob } from "@/lib/ledger/turns/queries";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { McpOperationError, notFound } from "@/lib/mcp/errors";
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
import {
  type AgentHealthLimits,
  billingSelfServe,
  getAgentHealthLimits,
} from "@/lib/platform/entitlements";
import { getLogger } from "@/lib/platform/logger";
import type { Organization } from "@/lib/platform/organizations";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { trackServerEvent } from "@/lib/platform/telemetry";
import {
  enqueueAssignTopicsJob,
  lastTopicReadingActivity,
  TOPIC_READING_COOLDOWN_MS,
} from "@/lib/readings/topics/queries";
import { signalsTitle } from "@/lib/readings/trace-signals/claims";
import { DISMISSABLE_KINDS, isDismissable } from "@/lib/readings/trace-signals/dismiss";
import { gainOf, type HealthScoreView } from "@/lib/readings/trace-signals/health-score";
import { type RunTrigger, setSignalDismissed } from "@/lib/readings/trace-signals/signals/queries";
import {
  agentHealthHref,
  applyPlanLimits,
  type EvidenceTurn,
  type FlowModel,
  type HealthPageModel,
  type HealthTile,
  healthReadiness,
  parseWindowDays,
  type SignalView,
  turnTracesHref,
  type WindowDays,
  windowOptionsForPlan,
} from "@/lib/readings/trace-signals/view";
import { issueHref } from "@/lib/views/fixes/href";
import { agentHealthEnabled, toIngestFlagOrganization } from "@/lib/views/health/agent-health-flag";
import { pageGap, signalsForGap } from "@/lib/views/health/data-gaps-model";
import type { ImportSummary } from "@/lib/views/health/imports-types";
import {
  type ExampleLimits,
  type IssueExamples,
  MAX_ISSUES_PER_REQUEST,
  readIssueExamples,
  turnsPerIssue,
} from "@/lib/views/health/issue-examples";
import { type IssueRow, issueRows, issuesLine } from "@/lib/views/health/issue-rows";
import { loadHealthPageModel, pendingHealthModel } from "@/lib/views/health/page-model";
import { type HealthPageState, READING_REQUEST_COOLDOWN_MS } from "@/lib/views/health/page-state";
import { healthStateCopy } from "@/lib/views/health/page-state-copy";
import { loadHealthPageState, type PageStateInput } from "@/lib/views/health/page-state-load";
import { requestHealthReading } from "@/lib/views/health/reading-request";
import {
  loadSelfCorrectionsCard,
  type SelfCorrectionsCardModel,
  unavailableSelfCorrectionsCard,
} from "@/lib/views/health/self-corrections/card";
import {
  loadSelfCorrectionsPage,
  type SelfCorrectionsPageRequest,
} from "@/lib/views/health/self-corrections/page-load";
import type { SelfCorrectionsPageModel } from "@/lib/views/health/self-corrections/page-model";
import { selfCorrectionsHref } from "@/lib/views/health/self-corrections/paths";
import { chainFolding } from "@/lib/views/health/workflows-view";

/**
 * Agent health over MCP: the Summary page (`get_agent_health`), an issue's
 * example turns (`list_issue_examples`), hiding a slow tool as slow by design
 * (`set_health_signal_hidden`), asking for a fresh reading of health or intents
 * (`request_analysis`) and the Self-corrections page (`get_self_corrections`).
 *
 * Each reads through the same `lib/**` functions as its console page and
 * applies the same gates and plan limits: `agentHealthEnabled`, the window cut
 * to `agentHealthWindowDays`, the issue list cut to `agentHealthSignalsShown`
 * and example turns cut to `turnsPerIssue`. A read never asks for work: where
 * the page would request a reading on view, this says so and points at
 * `request_analysis`. Search words and the agent's phrases are captured text,
 * returned only to a caller that may read it (`mayReadContent`).
 */

const logger = getLogger("mcp/health");

export interface HealthOperationDeps extends ContentAccessDeps {
  getOrganization: (projectId: string) => Promise<Organization | null>;
  agentHealthEnabled: (projectId: string, organization: Organization) => Promise<boolean>;
  /** The page's reading without example turns; null when it could not be read (the page's fallback). */
  loadHealthModel: (
    projectId: string,
    windowDays: WindowDays,
    limits: AgentHealthLimits,
  ) => Promise<HealthPageModel | null>;
  /** The project's recent imports; null when they could not be read (unknown, not none). */
  listImports: (projectId: string) => Promise<ImportSummary[] | null>;
  /**
   * How the edition names import sources ("LangSmith"), as the page's copy does; optional, and
   * without it a source is its id, capitalized.
   */
  importSourceLabels?: () => Promise<Readonly<Record<string, string>>>;
  loadPageState: (input: PageStateInput) => Promise<HealthPageState | null>;
  readIssueExamples: (
    projectId: string,
    ids: readonly string[],
    limits: ExampleLimits,
  ) => Promise<IssueExamples[]>;
  setSignalDismissed: (
    input: Parameters<typeof setSignalDismissed>[0],
  ) => Promise<{ id: string; kind: string } | null>;
  requestHealthReading: typeof requestHealthReading;
  /** The build a health reading rides on (`requestHealthReading`'s own default). */
  enqueueBuild: (projectId: string, reading: RunTrigger) => Promise<{ id: string } | null>;
  enqueueAssignTopicsJob: (projectId: string) => Promise<{ id: string } | null>;
  /** The latest an intents reading was queued or finished since then; null when none was. */
  lastTopicReadingActivity: (projectId: string, since: Date) => Promise<Date | null>;
  scheduleProjectDrain: (projectId: string) => void;
  loadSelfCorrectionsPage: (
    request: SelfCorrectionsPageRequest,
  ) => Promise<SelfCorrectionsPageModel>;
  loadSelfCorrectionsCard: (
    projectId: string,
    windowDays: WindowDays,
  ) => Promise<SelfCorrectionsCardModel>;
  trackServerEvent: typeof trackServerEvent;
  now: () => Date;
}

export const defaultHealthDeps: HealthOperationDeps = {
  getOrganization: (projectId) => getOrganizationByProjectId(projectId),
  agentHealthEnabled: (projectId, organization) =>
    agentHealthEnabled(projectId, toIngestFlagOrganization(organization)),
  loadHealthModel: (projectId, windowDays, limits) =>
    loadOrFallback<HealthPageModel | null>({
      operation: "mcp_agent_health_model",
      distinctId: `project:${projectId}`,
      fallback: null,
      // As the page reads it: example turns are read per issue (list_issue_examples).
      load: () =>
        loadHealthPageModel({ projectId, windowDays }, process.env.NODE_ENV, {
          getLimits: async () => ({ ...limits, agentHealthEvidenceTurns: 0 }),
        }),
    }),
  listImports: (projectId) =>
    loadOrFallback<ImportSummary[] | null>({
      operation: "mcp_agent_health_imports",
      distinctId: `project:${projectId}`,
      fallback: null,
      // Owned: imports are the edition's (`EditionUi.HealthImports`); without them, none.
      load: async () => {
        const slot = (await composition.ui?.())?.HealthImports;
        return slot ? [...(await slot.load(projectId)).list] : [];
      },
    }),
  importSourceLabels: async () => (await composition.ui?.())?.HealthImports?.sourceLabel ?? {},
  loadPageState: (input) => loadHealthPageState(input),
  readIssueExamples: (projectId, ids, limits) =>
    withStatementTimeout((db) => readIssueExamples(db, projectId, ids, limits), {
      operation: "agent_health_issue_examples",
    }),
  setSignalDismissed: (input) => setSignalDismissed(input),
  requestHealthReading,
  enqueueBuild: (projectId, reading) =>
    enqueueBuildTraceTurnsJob(projectId, undefined, { reading }),
  enqueueAssignTopicsJob: (projectId) => enqueueAssignTopicsJob(projectId),
  lastTopicReadingActivity: (projectId, since) =>
    withStatementTimeout((db) => lastTopicReadingActivity(projectId, since, db), {
      operation: "mcp_topic_reading_cooldown",
    }),
  scheduleProjectDrain: (projectId) => scheduleProjectDrain(projectId),
  loadSelfCorrectionsPage: (request) => loadSelfCorrectionsPage(request),
  loadSelfCorrectionsCard: (projectId, windowDays) =>
    loadOrFallback({
      operation: "mcp_self_corrections_card",
      distinctId: `project:${projectId}`,
      fallback: unavailableSelfCorrectionsCard(projectId, windowDays),
      load: () => loadSelfCorrectionsCard(projectId, windowDays),
    }),
  trackServerEvent,
  now: () => new Date(),
  contentOptIn: readContentOptIn,
};

/** Who acted, as stored rows and events name them: `project:<id>` for a key, the Clerk id for OAuth. */
export function mcpActor(auth: McpAuthContext, projectId: string): string {
  return auth.kind === "api-key" ? `project:${projectId}` : auth.externalUserId;
}

/** The analytics context of an MCP write, as `loop/index.ts` builds it. */
export function mcpEventContext(ctx: OperationContext) {
  const orgId = ctx.organizationId ? { orgId: ctx.organizationId } : {};
  return ctx.auth.kind === "api-key"
    ? { projectId: ctx.projectId, ...orgId }
    : { externalId: ctx.auth.externalUserId, projectId: ctx.projectId, ...orgId };
}

export const windowDaysParam = z
  .union([z.literal(7), z.literal(30), z.literal(90)])
  .default(7)
  .describe(
    "Days to read: 7, 30 or 90. A window longer than the plan includes falls back to the longest it does.",
  );

const FLOW_NODES = 15;
const FLOW_EDGES = 20;
const FLOW_PATHS = 10;
const STEPS_PER_TURN = 20;
const QUERY_CHARS = 200;
const PHRASE_CHARS = 120;
const SECTION_ROWS = 8;

async function requireOrganization(
  deps: HealthOperationDeps,
  projectId: string,
): Promise<Organization> {
  const organization = await deps.getOrganization(projectId);
  if (!organization) throw notFound("project");
  return organization;
}

/** Agent health is decided per project, as the page decides it; off, the page does not exist. */
async function requireAgentHealth(
  deps: HealthOperationDeps,
  projectId: string,
): Promise<Organization> {
  const organization = await requireOrganization(deps, projectId);
  if (!(await deps.agentHealthEnabled(projectId, organization))) {
    throw new McpOperationError("forbidden", "Agent health is not available for this project.", {
      reason: "agent_health_off",
    });
  }
  return organization;
}

function tileView(tile: HealthTile) {
  return {
    key: tile.key,
    label: tile.label,
    value: round(tile.value),
    unit: tile.unit,
    interval: tile.interval
      ? { low: round(tile.interval.low), high: round(tile.interval.high) }
      : null,
    sub: tile.sub,
    delta: round(tile.delta),
    upIsGood: tile.upIsGood,
    tier: tile.tier,
    n: tile.n,
  };
}

/**
 * The Health score as the page shows it (`components/health/v2/HealthScore.tsx`),
 * without its per-issue parts: each issue carries its own `points` instead.
 */
function scoreView(score: HealthScoreView) {
  return {
    value: score.value,
    band: score.band,
    change: score.change,
    trend: score.trend,
    outcome: round(score.outcome),
    pillars: score.pillars.map((reading) => ({
      pillar: reading.pillar,
      good: round(reading.good),
      n: reading.n,
    })),
    issueScore: score.issueScore,
    topGain: score.topGain,
    lost: score.lost,
    issues: score.issues,
  };
}

/** What a row is about, in a few words: "18 tools", "refund_payment, get_order +3", "Whole project". */
export function rowAbout(row: Pick<IssueRow, "tools" | "scope">): string | null {
  if (row.tools.count) return row.tools.count;
  const named = row.tools.shown.map((names) => names.join(" → ")).join(", ");
  if (named) return row.tools.more > 0 ? `${named} +${row.tools.more}` : named;
  return row.scope;
}

/**
 * One row of the page's Issues list (`components/health/v2/issue-rows.ts`): a
 * kind of issue with the issues it stands for, without the links only the
 * console can follow.
 */
function rowView(row: IssueRow) {
  return {
    key: row.key,
    kind: row.kind,
    title: row.title,
    tone: row.tone,
    tools: row.tools,
    scope: row.scope,
    about: rowAbout(row),
    figure: row.figure,
    memberIds: row.memberIds,
    /** Points fixing every issue of the row wins back; null without a score, or when it is too early to call. */
    points: row.points ?? null,
  };
}

/**
 * What the health view reads from a result's `view` (OperationResult.view, in
 * `_meta`): the Health score and the Issues list as the page shows them. Only
 * for a view, so the agent's result is exactly main's, flag or not.
 */
export interface HealthScoreViewData {
  kind: "health_score";
  /** Null when no reading is scored yet, or when a gap in the data hides it on the page. */
  score: ReturnType<typeof scoreView> | null;
  /** Whole points fixing each issue alone wins back now, by issue id. */
  points: Record<string, number>;
  /** The page's rows, in its order: one per kind of issue, then the ones too early to call. */
  rows: ReturnType<typeof rowView>[];
  /** The page's line over them: "9 issues across 17 tools, most points first." */
  line: string;
  /** The reading is early: the page marks the score "Calculating" and shows no change or trend against a full reading. */
  early: boolean;
  /** How far the early reading has got; null when it is not early, or the count failed. */
  progress: HealthPageModel["earlyProgress"] | null;
}

/**
 * The page's own score and rows (`readyReading` in `components/console/health/v2/SummaryView.tsx`),
 * through the same functions with the same inputs, so the card and the page
 * cannot disagree: a gap in the data hides the run-based issues and the score
 * over them, issues group by kind, and a row is worth what fixing all of it
 * wins back. Tasks and fixes only add links to a row, which the card leaves out.
 */
function healthScoreViewData(
  projectId: string,
  model: HealthPageModel,
): HealthScoreViewData & Record<string, unknown> {
  const gap = pageGap(model);
  const score = gap ? null : (model.score ?? null);
  const signals = signalsForGap(model.signals, gap);
  const rows = issueRows({
    projectId,
    signals,
    tooEarly: model.tooEarly,
    folding: chainFolding(model.workflows),
    tasks: [],
    fixes: null,
    score,
  });
  return {
    kind: "health_score",
    score: score ? scoreView(score) : null,
    points: score
      ? Object.fromEntries(signals.map((signal) => [signal.id, gainOf(score, [signal.id])]))
      : {},
    rows: rows.map(rowView),
    line: issuesLine(rows, signals),
    early: model.earlyReading === true,
    progress: model.earlyProgress ?? null,
  };
}

/** The page's Issues rows on their own, for a list of the same issues (list_insights' view). */
export interface HealthIssueRowsViewData {
  kind: "health_issue_rows";
  rows: HealthScoreViewData["rows"];
  /** The page's line over them; null when the rows are a part of the page's (one kind). */
  line: string | null;
}

/**
 * The Issues rows of a project's Agent health page, at the page's default
 * window and on the project's plan: what `get_agent_health` sends its view,
 * for another tool about the same issues. Null when Agent health is off for
 * the project or its model cannot be read: that tool's view then lists what
 * the tool returned.
 */
export async function loadHealthIssueRows(
  projectId: string,
  deps: Pick<
    HealthOperationDeps,
    "getOrganization" | "agentHealthEnabled" | "loadHealthModel"
  > = defaultHealthDeps,
): Promise<HealthIssueRowsViewData | null> {
  const organization = await deps.getOrganization(projectId);
  if (!organization || !(await deps.agentHealthEnabled(projectId, organization))) return null;
  const limits = getAgentHealthLimits(organization);
  const loaded = await deps.loadHealthModel(
    projectId,
    parseWindowDays(undefined, limits.agentHealthWindowDays),
    limits,
  );
  if (!loaded) return null;
  const { rows, line } = healthScoreViewData(projectId, applyPlanLimits(loaded, limits));
  return { kind: "health_issue_rows", rows, line };
}

function signalRow(projectId: string, signal: SignalView, tracker: TruncationTracker) {
  return {
    id: signal.id,
    kind: signal.kind,
    title: signalsTitle(signal.kind, [signal]),
    claim: tracker.text(signal.claim, 400),
    cost: signal.cost,
    whatToDo: tracker.text(signal.fix, 400),
    figure: signal.figure.display,
    caveat: signal.caveat,
    subject: {
      kind: signal.subject.kind,
      label: signal.subject.label,
      tools: signal.subject.chips.map((chip) => ({ id: chip.id, label: chip.label })),
    },
    tier: signal.tier,
    severity: round(signal.severity),
    impact: signal.impact,
    n: signal.n,
    hideable: isDismissable(signal.kind),
    firstSeenAt: signal.firstSeenAt,
    lastSeenAt: signal.lastSeenAt,
    href: issueHref(projectId, signal.id),
  };
}

/** The flow map, its busiest nodes, edges and journeys only. */
function flowView(flow: FlowModel, tracker: TruncationTracker) {
  const nodes = tracker.take(
    capRows(
      [...flow.nodes].sort((a, b) => b.invocations - a.invocations),
      FLOW_NODES,
    ),
  );
  const edges = tracker.take(
    capRows(
      [...flow.edges].sort((a, b) => b.count - a.count),
      FLOW_EDGES,
    ),
  );
  const journey = flow.journey;
  return {
    totalTools: flow.totalTools,
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      invocations: node.invocations,
      impressions: node.impressions,
      tint: node.tint,
      signalIds: node.signalIds,
    })),
    edges: edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      count: edge.count,
      tint: edge.tint,
    })),
    journeys: journey
      ? {
          turns: journey.turns,
          paths: tracker
            .take(
              capRows(
                [...journey.paths].sort((a, b) => b.turns - a.turns),
                FLOW_PATHS,
              ),
            )
            .map((path) => ({
              start: path.start,
              tools: path.tools,
              end: path.end,
              turns: path.turns,
            })),
        }
      : null,
  };
}

function importView(item: ImportSummary, tracker: TruncationTracker) {
  return {
    id: item.id,
    source: item.source,
    status: item.status,
    label: item.label,
    windowDays: item.windowDays,
    runsImported: item.runsImported,
    truncated: item.truncated,
    failure: item.failure,
    failureDetail: item.failureDetail ? tracker.text(item.failureDetail, 300) : null,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt,
  };
}

/** The page's state with its words, and the next move for an agent. */
function stateView(
  state: HealthPageState | null,
  windowDays: WindowDays,
  now: Date,
  plans: boolean,
  sourceLabel: Readonly<Record<string, string>>,
) {
  if (!state) return { kind: "collecting", title: "", body: "" };
  const copy = healthStateCopy(state, { windowDays, now, canImport: false, plans, sourceLabel });
  return { ...state, title: copy.title, body: copy.body };
}

function healthHint(
  model: HealthPageModel,
  state: HealthPageState | null,
  openIssues: number,
): string {
  if (
    state?.kind === "building" &&
    !state.working &&
    (state.phase === "computing" || state.phase === "stalled")
  ) {
    return "Runs no reading has read yet are waiting. Call request_analysis with what: health to start one, then get_analysis_freshness with section health.";
  }
  if (healthReadiness(model) !== "ready")
    return "Too early to call: a reading needs more turns. Check get_analysis_freshness, or try a wider windowDays.";
  return openIssues > 0
    ? "list_issue_examples with issue ids shows the turns behind an issue; list_insights and get_fix turn an issue into a change. get_self_corrections reads the agent's self-corrections."
    : "No open issues in this window. get_self_corrections reads the agent's self-corrections.";
}

function storyStep(
  step: EvidenceTurn["steps"][number],
  tracker: TruncationTracker,
  content: boolean,
) {
  if (step.kind === "search") {
    const query =
      content && step.query.state === "captured"
        ? tracker.text(step.query.text, QUERY_CHARS)
        : null;
    return {
      kind: "search" as const,
      query,
      queryState: step.query.state,
      listed: step.listed,
      flag: step.flag?.label ?? null,
    };
  }
  return {
    kind: "invoke" as const,
    toolId: step.toolId,
    pickedRank: step.pickedRank,
    outcome: step.outcome,
    tookMs: step.tookMs,
    flag: step.flag?.label ?? null,
  };
}

function exampleTurn(
  projectId: string,
  turn: EvidenceTurn,
  tracker: TruncationTracker,
  content: boolean,
) {
  return {
    turnId: turn.turnId,
    traceId: turn.traceId,
    startedAt: turn.startedAt,
    turnSource: turn.turnSource,
    steps: tracker
      .take(capRows(turn.steps, STEPS_PER_TURN))
      .map((step) => storyStep(step, tracker, content)),
    href: turnTracesHref(projectId, turn.turnId),
  };
}

/** An example's one sentence without the agent's words: the default sentence quotes its phrase. */
function exampleSummary(
  example: SelfCorrectionsPageModel["examples"][number],
  content: boolean,
): string {
  if (content || !example.phrase || !example.summary.includes(example.phrase))
    return example.summary;
  return "The agent corrected itself.";
}

function selfCorrectionsView(
  page: SelfCorrectionsPageModel,
  card: SelfCorrectionsCardModel,
  limit: number,
  tracker: TruncationTracker,
  content: boolean,
) {
  const rows = <T>(items: readonly T[]) =>
    tracker.take(capRows(items, Math.min(limit, SECTION_ROWS)));
  return {
    state: page.state,
    windowDays: page.windowDays,
    computedAt: page.computedAt,
    filters: page.filters.map((filter) => ({
      field: filter.field,
      label: filter.label,
      value: filter.value,
    })),
    turns: page.turns,
    events: page.events,
    headline: {
      rate: card.rate,
      recovered: card.recovered,
      recoveredShare: round(card.recoveredShare),
      topTool: card.topTool
        ? {
            id: card.topTool.entryId,
            name: card.topTool.name,
            events: card.topTool.events,
            mainKind: card.topTool.mainKind,
          }
        : null,
      topPhrase:
        content && card.phrasesCaptured && card.topPhrase
          ? {
              phrase: tracker.text(card.topPhrase.phrase, PHRASE_CHARS),
              events: card.topPhrase.events,
            }
          : null,
    },
    stats: page.stats,
    trend: page.trend ? { values: page.trend.values, bucketDays: page.trend.bucketDays } : null,
    byKind: page.byKind.map((row) => ({
      kind: row.kind,
      label: row.label,
      events: row.events,
      share: round(row.share),
      measured: row.measured,
    })),
    byTool: rows(page.byTool).map((row) => ({
      id: row.entryId,
      kind: row.entryKind,
      name: row.name,
      events: row.events,
      share: round(row.share),
      mainKind: row.mainKind,
      task: row.task ? { id: row.task.id, name: row.task.name } : null,
    })),
    withoutTool: page.withoutTool,
    byTask: rows(page.byTask).map((row) => ({
      id: row.id,
      name: row.name,
      events: row.events,
      turns: row.turns,
      per100: round(row.per100, 1),
      share: round(row.share),
    })),
    unplaced: page.unplaced,
    byIntent: page.byTopic
      ? rows(page.byTopic).map((row) => ({
          id: row.id,
          name: row.name,
          events: row.events,
          turns: row.turns,
          per100: round(row.per100, 1),
          share: round(row.share),
        }))
      : null,
    // The agent's own phrases, shown on the page only when its replies were captured.
    phrases:
      content && page.phrases.captured
        ? rows(page.phrases.top).map((row) => ({
            phrase: tracker.text(row.phrase, PHRASE_CHARS),
            kind: row.kindLabel,
            events: row.events,
            share: round(row.share),
          }))
        : null,
    examples: rows(page.examples).map((example) => ({
      id: example.id,
      kind: example.kindLabel,
      phrase: content && example.phrase ? tracker.text(example.phrase, PHRASE_CHARS) : null,
      summary: exampleSummary(example, content),
      context: example.context,
      occurredAt: example.occurredAt,
      href: example.traceHref,
    })),
    fixes: page.fixes.map((fix) => ({
      issueId: fix.id,
      fix: tracker.text(fix.fix, 400),
      why: tracker.text(fix.why, 400),
      reason: fix.reason,
      pattern: fix.pattern,
      subject: { kind: fix.subject.kind, id: fix.subject.id, name: fix.subject.name },
      descriptionTool: fix.descriptionTool,
      href: fix.issueHref,
    })),
  };
}

export function healthOperations(deps: HealthOperationDeps = defaultHealthDeps): McpOperation[] {
  return [
    defineOperation({
      id: "get_agent_health",
      domain: "observability",
      title: "Get agent health",
      description:
        "The Agent health page for a 7, 30 or 90 day window: tiles, turn shapes, flow map, capture level and what more capture unlocks, setup, page state, open issues (cut to the plan) and hidden ones, recent imports. Call list_issue_examples for an issue's turns.",
      keywords: [
        "health summary",
        "turn shapes",
        "flow map",
        "capture level",
        "too early to call",
        "health imports",
      ],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, windowDays: windowDaysParam, limit: limitParam }),
      async execute(ctx, params) {
        const organization = await requireAgentHealth(deps, ctx.projectId);
        const limits = getAgentHealthLimits(organization);
        const windowDays = parseWindowDays(String(params.windowDays), limits.agentHealthWindowDays);
        const tracker = new TruncationTracker();
        const [loaded, imports, sourceLabel] = await Promise.all([
          deps.loadHealthModel(ctx.projectId, windowDays, limits),
          deps.listImports(ctx.projectId),
          deps.importSourceLabels?.() ?? {},
        ]);
        const model = applyPlanLimits(loaded ?? pendingHealthModel(windowDays), limits);
        // Read only: the page asks for a reading on view; an MCP read never does (request_analysis does).
        const state = await deps.loadPageState({
          projectId: ctx.projectId,
          organizationId: organization.id,
          model,
          modelUnavailable: loaded === null,
          imports,
          planWindowDays: limits.agentHealthWindowDays,
          readOnly: true,
        });
        const openIssues = model.signals.length + model.lockedCount;
        // The Health score and the page's rows go to the view alone.
        const view = ctx.forView ? healthScoreViewData(ctx.projectId, model) : null;
        const issues = tracker.take(capRows(model.signals, params.limit));
        return {
          ...(view ? { view } : {}),
          data: {
            windowDays,
            ...(windowDays !== params.windowDays ? { requestedWindowDays: params.windowDays } : {}),
            windowOptions: windowOptionsForPlan(limits.agentHealthWindowDays)
              .filter((option) => !option.locked)
              .map((option) => option.days),
            readiness: healthReadiness(model),
            state: stateView(
              state,
              windowDays,
              deps.now(),
              billingSelfServe(organization),
              sourceLabel,
            ),
            turns: model.turns,
            floor: model.floor,
            computedAt: model.computedAt,
            signalWindowDays: model.signalWindowDays,
            sourceMode: model.sourceMode,
            turnSourceMix: model.turnSourceMix,
            captureLevel: model.captureLevel,
            captureUnlocks: model.captureUnlocks.map((unlock) => ({
              label: unlock.label,
              description: unlock.description,
            })),
            setup: model.setup ?? null,
            tiles: model.tiles.map(tileView),
            shapes: model.shapes.map((shape) => ({
              shape: shape.shape,
              label: shape.label,
              share: round(shape.share),
              count: shape.count,
            })),
            flow: flowView(model.flow, tracker),
            tasks: model.workflows
              ? tracker.take(capRows(model.workflows.items, SECTION_ROWS)).map((row) => ({
                  id: row.id,
                  name: row.name,
                  runs: row.runs,
                  share: round(row.share),
                  completion: round(row.completion),
                  medianMs: row.medianMs,
                }))
              : null,
            openIssueCount: openIssues,
            issues: issues.map((signal) => signalRow(ctx.projectId, signal, tracker)),
            lockedIssueCount: model.lockedCount,
            tooEarly: model.tooEarly.map((signal) => signalRow(ctx.projectId, signal, tracker)),
            hiddenIssues: (model.dismissed ?? []).map((hidden) => ({
              id: hidden.id,
              kind: hidden.kind,
              toolId: hidden.toolId,
              label: hidden.label,
            })),
            exampleTurnsPerIssue: model.evidenceTurnsPerSignal,
            imports: imports ? imports.map((item) => importView(item, tracker)) : null,
            href: agentHealthHref(ctx.projectId, windowDays),
          },
          truncated: tracker.value,
          hint: healthHint(model, state, openIssues),
        };
      },
    }),
    defineOperation({
      id: "list_issue_examples",
      domain: "observability",
      title: "List issue examples",
      description:
        "Example turns behind one or more Agent health issues, newest first: each step of the turn (search, tool call, outcome, rank) with the step the issue is about flagged. Turns per issue follow the plan; none on a plan without examples. Issue ids come from get_agent_health.",
      keywords: ["issue examples", "example turns", "evidence turns"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        issueIds: z
          .array(uuidParam())
          .min(1)
          .max(MAX_ISSUES_PER_REQUEST)
          .describe("Issue ids from get_agent_health or list_insights."),
      }),
      async execute(ctx, params) {
        const organization = await requireAgentHealth(deps, ctx.projectId);
        const limits = getAgentHealthLimits(organization);
        const exampleLimits: ExampleLimits = {
          perIssue: turnsPerIssue(limits.agentHealthEvidenceTurns),
          shown: limits.agentHealthSignalsShown,
        };
        // The plan shows no example turns: say so without reading any, as the console does.
        if (exampleLimits.perIssue <= 0) {
          return {
            data: { locked: true, examples: [] },
            hint: "This plan shows no example turns. A paid plan shows them.",
          };
        }
        const ids = [...new Set(params.issueIds)];
        const tracker = new TruncationTracker();
        const [examples, content] = await Promise.all([
          deps.readIssueExamples(ctx.projectId, ids, exampleLimits),
          mayReadContent(ctx, deps),
        ]);
        return {
          data: {
            locked: false,
            turnsPerIssue: exampleLimits.perIssue,
            examples: examples.map((issue) => ({
              id: issue.id,
              total: issue.total,
              turns: issue.turns.map((turn) => exampleTurn(ctx.projectId, turn, tracker, content)),
            })),
            ...withheldMarker(content),
          },
          truncated: tracker.value,
          hint: contentHint(
            content,
            examples.length < ids.length
              ? "An id with no examples is not an open issue of this project, or is past the plan's issue limit."
              : "get_trace with a traceId opens a turn's full trace.",
          ),
        };
      },
    }),
    defineOperation({
      id: "set_health_signal_hidden",
      domain: "writes",
      title: "Hide or show a slow tool issue",
      description:
        "Hide an open slow tool issue (latency_outlier or wait_heavy) as slow by design, or show a hidden one again. Changes what the team's Agent health page lists, not what is measured. Hidden issues appear in get_agent_health as hiddenIssues.",
      keywords: ["slow by design", "hide issue", "dismiss issue", "show again"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        signalId: uuidParam().describe(
          "The issue id from get_agent_health (issues or hiddenIssues).",
        ),
        hidden: z
          .boolean()
          .describe("true hides the issue as slow by design; false shows it again."),
      }),
      async execute(ctx, params) {
        await requireAgentHealth(deps, ctx.projectId);
        const changed = await deps.setSignalDismissed({
          projectId: ctx.projectId,
          signalId: params.signalId,
          kinds: DISMISSABLE_KINDS,
          dismissed: params.hidden,
          by: mcpActor(ctx.auth, ctx.projectId),
        });
        if (!changed) {
          throw new McpOperationError(
            "not_found",
            params.hidden
              ? "No open slow tool issue with that id. Only latency_outlier and wait_heavy issues can be hidden."
              : "No hidden issue with that id.",
            { reason: "not_hideable" },
          );
        }
        const event = params.hidden ? "health_signal_dismissed" : "health_signal_restored";
        await deps.trackServerEvent(event, mcpEventContext(ctx), {
          object_action: event,
          kind: changed.kind,
          ...(params.hidden ? { reason: "slow_by_design" } : {}),
          surface: "mcp",
        });
        return {
          data: { id: changed.id, kind: changed.kind, hidden: params.hidden },
          hint: params.hidden
            ? "Hidden. Call set_health_signal_hidden with hidden: false to show it again."
            : "Shown again: it is back in get_agent_health's issues.",
        };
      },
    }),
    defineOperation({
      id: "request_analysis",
      domain: "writes",
      title: "Request a fresh reading",
      description:
        "Ask for a fresh reading of Agent health (what: health) or of Intents (what: intents), each with a 10 minute cooldown. Returns the job id to poll with get_job_status, or the cooldown. Then get_analysis_freshness.",
      keywords: ["read now", "recompute", "refresh reading", "rerun analysis"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        what: z
          .enum(["health", "intents"])
          .describe("health: the Agent health reading. intents: the Intents reading."),
      }),
      async execute(ctx, params) {
        if (params.what === "intents") {
          await requireOrganization(deps, ctx.projectId);
          // Each reading names intents with a model on Ratel's account: one per 10 minutes, whoever asked.
          const at = deps.now();
          const last = await deps.lastTopicReadingActivity(
            ctx.projectId,
            new Date(at.getTime() - TOPIC_READING_COOLDOWN_MS),
          );
          if (last) {
            const waitMs = last.getTime() + TOPIC_READING_COOLDOWN_MS - at.getTime();
            return {
              data: {
                what: "intents",
                queued: false,
                reason: "cooldown",
                retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
              },
              hint: "An intents reading was queued or finished in the last 10 minutes. get_analysis_freshness with section intents shows whether it is running; list_intents reads the latest.",
            };
          }
          const queued = await deps.enqueueAssignTopicsJob(ctx.projectId);
          deps.scheduleProjectDrain(ctx.projectId);
          await deps.trackServerEvent("topic_run_requested", mcpEventContext(ctx), {
            object_action: "topic_run_requested",
            coalesced: queued === null,
            surface: "mcp",
          });
          return {
            data: {
              what: "intents",
              queued: true,
              jobId: queued?.id ?? null,
              coalesced: queued === null,
            },
            hint: queued
              ? "Poll get_job_status with this jobId; once it completes, list_intents reads the new reading."
              : "A reading was already waiting, so none was added. get_job_status without a jobId lists it.",
          };
        }

        const organization = await requireAgentHealth(deps, ctx.projectId);
        let attempted = false;
        let failed = false;
        let build: { id: string } | null = null;
        const requested = await deps.requestHealthReading(
          { projectId: ctx.projectId, organizationId: organization.id, reason: "mcp_request" },
          {
            enqueueBuild: async (projectId, reading) => {
              attempted = true;
              try {
                build = await deps.enqueueBuild(projectId, reading);
                return build;
              } catch (err) {
                failed = true;
                throw err;
              }
            },
            // The reading request's own event, said as the MCP caller rather than the page.
            trackServerEvent: (event, _context, properties) =>
              deps.trackServerEvent(event, mcpEventContext(ctx), {
                ...properties,
                source: "mcp",
                surface: "mcp",
              }),
          },
        );
        if (!attempted) {
          return {
            data: {
              what: "health",
              queued: false,
              reason: "cooldown",
              retryAfterSeconds: READING_REQUEST_COOLDOWN_MS / 1000,
            },
            hint: "A reading was asked for in the last 10 minutes. get_analysis_freshness with section health shows whether it is running.",
          };
        }
        if (!requested || failed) {
          logger.error({ project_id: ctx.projectId }, "mcp health reading request failed");
          throw new McpOperationError(
            "internal",
            "The reading could not be queued. Try again in a few minutes.",
          );
        }
        const jobId = (build as { id: string } | null)?.id ?? null;
        return {
          data: { what: "health", queued: true, jobId, coalesced: jobId === null },
          hint: jobId
            ? "This queues a turn build that then starts the reading. Poll get_job_status with this jobId, then get_analysis_freshness with section health, then get_agent_health."
            : "A build was already queued; the reading rides on it. get_analysis_freshness with section health shows its progress.",
        };
      },
    }),
    defineOperation({
      id: "get_self_corrections",
      domain: "observability",
      title: "Get self-corrections",
      description:
        "The Self-corrections page: how often the agent goes back on itself per 100 turns against the window before, by kind, after which tool, by task and by intent, top phrases (when replies are captured), recent examples and the fixes of open issues. Filter by tool, task or intent.",
      keywords: [
        "self-corrections",
        "self corrections",
        "retried",
        "apologized",
        "went back on itself",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        windowDays: windowDaysParam,
        tool: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Only after this tool: a catalog id, or skill:<id>."),
        task: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Only in this task id (get_agent_health tasks)."),
        intent: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Only in this intent id (list_intents)."),
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const organization = await requireOrganization(deps, ctx.projectId);
        const limits = getAgentHealthLimits(organization);
        const windowDays = parseWindowDays(String(params.windowDays), limits.agentHealthWindowDays);
        const filters = {
          tool: params.tool ?? null,
          task: params.task ?? null,
          topic: params.intent ?? null,
        };
        const tracker = new TruncationTracker();
        const [page, card, content] = await Promise.all([
          deps.loadSelfCorrectionsPage({ projectId: ctx.projectId, windowDays, filters }),
          deps.loadSelfCorrectionsCard(ctx.projectId, windowDays),
          mayReadContent(ctx, deps),
        ]);
        return {
          data: {
            ...selfCorrectionsView(page, card, params.limit, tracker, content),
            ...(windowDays !== params.windowDays ? { requestedWindowDays: params.windowDays } : {}),
            href: selfCorrectionsHref(ctx.projectId, { days: windowDays, filters }),
            ...withheldMarker(content),
          },
          truncated: tracker.value,
          hint: contentHint(
            content,
            page.state === "not_read"
              ? "No reading has written self-corrections yet. request_analysis with what: health starts one."
              : "get_fix with a fix's issueId as insightId returns the change; get_session replays a session step by step.",
          ),
        };
      },
    }),
  ];
}
