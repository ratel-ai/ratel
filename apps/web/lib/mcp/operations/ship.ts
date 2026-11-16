import { z } from "zod";
import { invalidParams, McpOperationError, notFound } from "@/lib/mcp/errors";
import { mcpActor } from "@/lib/mcp/operations/health";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation, type OperationContext } from "@/lib/mcp/registry";
import { capRows, limitParam, round, TruncationTracker } from "@/lib/mcp/serialize";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import { getOrganizationByProjectId, type Organization } from "@/lib/platform/organizations";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import { loadFixes } from "@/lib/views/fixes/load";
import { loadAnalysisFreshness, loadSectionProgress } from "@/lib/views/freshness/load";
import {
  type AnalysisFreshness,
  describeFreshness,
  type SectionProgress,
} from "@/lib/views/freshness/model";
import {
  ANALYSIS_SECTIONS,
  type AnalysisSection,
  sectionJobKinds,
} from "@/lib/views/freshness/sections";
import { lineageShowsTraces } from "@/lib/views/lineage/plan";
import { chainOf, sourceOf } from "@/lib/views/lineage/resolve";
import { loadShipments, type ShipmentRow } from "@/lib/views/lineage/shipments";
import { shipmentTrail } from "@/lib/views/lineage/trail";
import { LINEAGE_KINDS, type LineageRef, stageOfKind } from "@/lib/views/lineage/types";
import { loadSessionLens } from "@/lib/views/session-replay/annotations-load";
import { sessionReplayEnabledForActor } from "@/lib/views/session-replay/gate";
import { loadSessionTimeline } from "@/lib/views/session-replay/load";
import { contentOptIn } from "@/lib/views/session-replay/runs";
import { loadStepTexts, type StepText } from "@/lib/views/session-replay/settings";
import type { TimelineStep } from "@/lib/views/session-replay/timeline";
import {
  buildSessionView,
  type SessionView,
  sessionReplayHref,
} from "@/lib/views/session-replay/view";
import {
  forkTargets,
  listWhatIfRuns,
  loadWhatIfOptions,
  sessionTools,
  type WhatIfOptions,
  type WhatIfRunView,
  withSessionToolsFirst,
} from "@/lib/views/session-replay/what-if";
import { stageSpineEnabled } from "@/lib/views/stage-spine-flag";

/**
 * Ship and the reads around it over MCP: what went live (`list_shipments`),
 * where any object came from (`get_lineage`), how fresh the analysis is
 * (`get_analysis_freshness`) and one session step by step (`get_session`).
 *
 * Gates follow the console. Ship and lineage live behind `cloud-stage-spine`,
 * session replay behind `cloud-session-replay`. A bearer caller has no cookie
 * session, so each flag is decided for the caller acting in the project's
 * organization, as `loop/index.ts` decides the eval gate: an OAuth user as
 * their Clerk id with their email, an API key as `project:<id>` with the
 * organization's properties. Whether an insight may name the run it came from
 * follows the plan (`lineageShowsTraces`), as on the lineage route.
 */

const logger = getLogger("mcp/ship");

/** The steps `get_session` returns: `steps` of them from the `offset`-th, in the view's order. */
export interface StepWindow {
  offset: number;
  steps: number;
}

/** A loaded session as the page holds it, before it is cut for a context window. */
export interface LoadedSession {
  view: SessionView;
  readContent: boolean;
  /** Message text by step index, for the asked-for window only; empty unless asked for and the project's content opt-in is on. */
  texts: Record<number, StepText>;
  forkableCalls: number;
  tools: string[];
  runs: WhatIfRunView[];
}

export interface ShipOperationDeps {
  getOrganization: (projectId: string) => Promise<Organization | null>;
  /** `cloud-stage-spine` for this caller in the project's organization. */
  stageSpineEnabled: (projectId: string, actor: string) => Promise<boolean>;
  evalGateEnabled: (projectId: string, actor: string) => Promise<boolean>;
  loadShipments: (projectId: string) => Promise<ShipmentRow[]>;
  shipmentTrail: (
    shipment: ShipmentRow,
    ctx: { projectId: string; traces: boolean; evals: boolean },
  ) => Promise<LineageRef[]>;
  resolveLineage: (
    ref: LineageRef,
    ctx: { projectId: string; traces: boolean },
    chain: boolean,
  ) => Promise<LineageRef | LineageRef[] | null>;
  loadFreshness: (
    projectId: string,
    section: AnalysisSection | null,
  ) => Promise<{ freshness: AnalysisFreshness; progress: SectionProgress | null }>;
  sessionReplayEnabled: (projectId: string, actor: string) => Promise<boolean>;
  /** `textWindow` names the steps whose message text to read; null reads none. */
  loadSession: (
    projectId: string,
    sessionId: string,
    textWindow: StepWindow | null,
  ) => Promise<LoadedSession | null>;
  loadWhatIfOptions: (projectId: string, organization: Organization) => Promise<WhatIfOptions>;
  now: () => Date;
}

/**
 * `cloud-stage-spine` for whoever asked, with no session, as
 * `sessionReplayEnabledForActor` decides its flag: a person with their email,
 * a key with the organization's properties only. An unknown project is off.
 */
export async function stageSpineEnabledForActor(
  _projectId: string,
  _actor: string,
): Promise<boolean> {
  // Owned: the stage spine is the deployment's FF_STAGE_SPINE (views/stage-spine-flag.ts).
  // Upstream decides cloud-stage-spine per organization and person through its flag service.
  return stageSpineEnabled();
}

/**
 * The model calls in the window that kept their text: the only ones whose text
 * is read, so a long session costs one window's texts, not all of them.
 */
export function textCallsInWindow(
  view: Pick<SessionView, "rows">,
  steps: readonly TimelineStep[],
  window: StepWindow,
): { index: number; eventId: string }[] {
  const shown = new Set(
    view.rows.slice(window.offset, window.offset + window.steps).map((row) => row.index),
  );
  return steps.flatMap((step) =>
    step.kind === "model_call" && step.coverage === "content" && shown.has(step.index)
      ? [{ index: step.index, eventId: step.eventId }]
      : [],
  );
}

/** The session page's read, under one statement timeout. */
async function readSession(
  projectId: string,
  sessionId: string,
  textWindow: StepWindow | null,
): Promise<LoadedSession | null> {
  return withStatementTimeout(
    async (db) => {
      const timeline = await loadSessionTimeline(projectId, sessionId, db);
      if (!timeline) return null;
      const view = buildSessionView(timeline, await loadSessionLens(projectId, timeline, db));
      const readContent = await contentOptIn(projectId, db);
      const base = {
        view,
        readContent,
        forkableCalls: Object.keys(forkTargets(timeline)).length,
        tools: sessionTools(timeline),
        runs: await listWhatIfRuns(projectId, sessionId, db),
      };
      // Text only when the project opted in, and only for calls that kept it: the page's rule.
      if (!readContent || !textWindow) return { ...base, texts: {} };
      const calls = textCallsInWindow(view, timeline.steps, textWindow);
      if (calls.length === 0) return { ...base, texts: {} };
      const byEvent = await loadStepTexts(
        projectId,
        calls.map((call) => call.eventId),
        db,
      );
      const texts: Record<number, StepText> = {};
      for (const call of calls) {
        const text = byEvent.get(call.eventId);
        if (text) texts[call.index] = text;
      }
      return { ...base, texts };
    },
    { operation: "session_replay_page" },
  );
}

export const defaultShipDeps: ShipOperationDeps = {
  getOrganization: (projectId) => getOrganizationByProjectId(projectId),
  stageSpineEnabled: (projectId, actor) => stageSpineEnabledForActor(projectId, actor),
  evalGateEnabled: (projectId, actor) => evalGateEnabledForActor(projectId, actor),
  loadShipments: (projectId) =>
    withStatementTimeout((db) => loadShipments(projectId, db), { operation: "ship_shipments" }),
  shipmentTrail: (shipment, ctx) =>
    loadOrFallback<LineageRef[]>({
      operation: "ship_lineage_chain",
      distinctId: `project:${ctx.projectId}`,
      // As the page falls back: the step it already knows.
      fallback: shipment.source ? [shipment.source, shipment.ref] : [shipment.ref],
      load: () =>
        withStatementTimeout((db) => shipmentTrail(shipment.ref, { ...ctx, db }, shipment.source), {
          operation: "ship_lineage_chain",
        }),
    }),
  resolveLineage: (ref, ctx, chain) =>
    withStatementTimeout<LineageRef | LineageRef[] | null>(
      (db) => (chain ? chainOf(ref, { ...ctx, db }) : sourceOf(ref, { ...ctx, db })),
      { operation: "lineage_resolve", timeoutMs: supplementaryReadTimeoutMs() },
    ),
  loadFreshness: (projectId, section) =>
    withStatementTimeout(
      async (db) => ({
        freshness: await loadAnalysisFreshness(db, projectId),
        progress: section
          ? await loadSectionProgress(db, projectId, sectionJobKinds(section))
          : null,
      }),
      { operation: "analysis_freshness", timeoutMs: supplementaryReadTimeoutMs() },
    ),
  sessionReplayEnabled: (projectId, actor) => sessionReplayEnabledForActor(projectId, actor),
  loadSession: readSession,
  loadWhatIfOptions: (projectId, organization) =>
    loadWhatIfOptions(
      projectId,
      async (id) => (await loadFixes({ projectId: id, organization, topics: false })).open,
    ),
  now: () => new Date(),
};

const LINEAGE_KIND_VALUES = Object.values(LINEAGE_KINDS).flat() as [string, ...string[]];
const SECTION_VALUES = Object.keys(ANALYSIS_SECTIONS) as [AnalysisSection, ...AnalysisSection[]];

/** Shipments whose full trail is walked per call: each walk is a few reads, so only the newest get one. */
const TRAILS_PER_CALL = 5;
const TEXT_CHARS = 400;
const MESSAGES_SHOWN = 3;
const WHAT_IF_FIXES = 20;
const WHAT_IF_TOOLS = 20;
const WHAT_IF_RUNS = 10;

async function requireOrganization(
  deps: ShipOperationDeps,
  projectId: string,
): Promise<Organization> {
  const organization = await deps.getOrganization(projectId);
  if (!organization) throw notFound("project");
  return organization;
}

/** Ship and lineage exist behind `cloud-stage-spine`; off, the pages do not exist. */
async function requireStageSpine(deps: ShipOperationDeps, ctx: OperationContext): Promise<string> {
  const actor = mcpActor(ctx.auth, ctx.projectId);
  if (!(await deps.stageSpineEnabled(ctx.projectId, actor))) {
    throw new McpOperationError(
      "forbidden",
      "Ship and lineage are not enabled for this organization.",
      { reason: "stage_spine_off" },
    );
  }
  return actor;
}

async function evalsFor(
  deps: ShipOperationDeps,
  projectId: string,
  actor: string,
): Promise<boolean> {
  try {
    return await deps.evalGateEnabled(projectId, actor);
  } catch (err) {
    // The trail only loses its eval step, as on the page.
    logger.error({ err, project_id: projectId }, "eval gate decision failed for ship trail");
    return false;
  }
}

function textView(text: StepText, tracker: TruncationTracker) {
  const kept = text.messages.slice(-MESSAGES_SHOWN);
  tracker.mark(kept.length < text.messages.length);
  return {
    system: text.system ? tracker.text(text.system, TEXT_CHARS) : null,
    messages: kept.map((message) => ({
      role: message.role,
      text: tracker.text(message.text, TEXT_CHARS),
    })),
    omitted: text.omitted + (text.messages.length - kept.length),
  };
}

function sessionRow(
  row: SessionView["rows"][number],
  text: StepText | undefined,
  tracker: TruncationTracker,
) {
  return {
    index: row.index,
    kind: row.kind,
    turn: row.turnIndex,
    title: row.title,
    detail: row.detail,
    at: row.at,
    coverage: row.coverage,
    marks: row.marks.map((mark) => mark.label),
    context: row.bar
      ? {
          inputTokens: row.bar.total,
          parts: row.bar.segments.map((segment) => ({
            part: segment.label,
            tokens: segment.tokens,
            share: round(segment.share),
          })),
        }
      : null,
    notes: row.markers.map((marker) => marker.text),
    toolChoice: row.chips.map((chip) => ({ verdict: chip.tone, text: chip.text })),
    ...(text ? { text: textView(text, tracker) } : {}),
  };
}

export function shipOperations(deps: ShipOperationDeps = defaultShipDeps): McpOperation[] {
  return [
    defineOperation({
      id: "list_shipments",
      domain: "improvement",
      title: "List shipments",
      description:
        "The Ship page: changes that went live, newest first (shipments recorded with mark_fix_shipped and applied description rewrites), each with the fix it came from and, for the newest few, its trail back to the run it started from. Use get_lineage for any other object.",
      keywords: ["shipped changes", "what went live", "ship page", "releases"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        shipmentId: z
          .string()
          .min(1)
          .max(512)
          .optional()
          .describe("Only this shipment, with its full trail."),
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const actor = await requireStageSpine(deps, ctx);
        const organization = await requireOrganization(deps, ctx.projectId);
        const tracker = new TruncationTracker();
        const all = await deps.loadShipments(ctx.projectId);
        const matching = params.shipmentId
          ? all.filter((row) => row.ref.id === params.shipmentId)
          : all;
        if (params.shipmentId && matching.length === 0) throw notFound("shipment");
        const page = tracker.take(capRows(matching, params.limit));
        const trailCtx = {
          projectId: ctx.projectId,
          traces: lineageShowsTraces(organization),
          evals: await evalsFor(deps, ctx.projectId, actor),
        };
        const shipments = [];
        // One after another: each trail is its own bounded read.
        for (const [index, row] of page.entries()) {
          const trail = index < TRAILS_PER_CALL ? await deps.shipmentTrail(row, trailCtx) : null;
          shipments.push({
            id: row.ref.id,
            title: row.title,
            shippedAt: row.shippedAt,
            href: row.ref.href ?? null,
            source: row.source,
            trail,
          });
        }
        return {
          data: { count: matching.length, shipments },
          truncated: tracker.value,
          hint:
            matching.length === 0
              ? "Nothing shipped yet. A fix applied or marked with mark_fix_shipped shows up here."
              : `Trails are walked for the ${TRAILS_PER_CALL} newest only; pass shipmentId, or get_lineage with kind shipment and chain: true, for any other.`,
        };
      },
    }),
    defineOperation({
      id: "get_lineage",
      domain: "improvement",
      title: "Get lineage",
      description:
        "Where an object came from: one step back (source) or the full chain back to the run (chain: true, oldest first), for kind trace, metric, insight, intent, task, fix, experiment, eval or shipment and its id. On a plan without example turns an insight names its metric, not its run.",
      keywords: ["lineage", "where did this come from", "source chain", "provenance"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        kind: z.enum(LINEAGE_KIND_VALUES).describe("The object's kind."),
        id: z
          .string()
          .min(1)
          .max(512)
          .describe("The object's id, e.g. an insight id, issue:<id> for a fix, or a shipment id."),
        chain: z
          .boolean()
          .default(false)
          .describe("true: the whole chain back to Monitor. false: one step back."),
      }),
      async execute(ctx, params) {
        await requireStageSpine(deps, ctx);
        const organization = await requireOrganization(deps, ctx.projectId);
        const stage = stageOfKind(params.kind);
        if (!stage) throw invalidParams("Name an object by its kind and id.");
        const ref: LineageRef = { stage, kind: params.kind, id: params.id };
        const resolved = await deps.resolveLineage(
          ref,
          { projectId: ctx.projectId, traces: lineageShowsTraces(organization) },
          params.chain,
        );
        if (params.chain) {
          const chain = Array.isArray(resolved) ? resolved : [ref];
          return {
            data: { ref, chain },
            hint:
              chain.length <= 1
                ? "Nothing is recorded or derivable before this object."
                : undefined,
          };
        }
        const source = Array.isArray(resolved) ? null : resolved;
        return {
          data: { ref, source },
          hint: source
            ? "Call get_lineage on the source to walk further back, or pass chain: true."
            : "This object starts its chain, or nothing says where it came from.",
        };
      },
    }),
    defineOperation({
      id: "get_analysis_freshness",
      domain: "observability",
      title: "Get analysis freshness",
      description:
        "When the project's analysis last finished, whether it is working now and import progress; with section (overview, health, self_corrections, tasks, intents, fixes) also that page's last finished time and pending jobs. Poll after request_analysis; get_job_status follows one job.",
      keywords: ["freshness", "last updated", "analysis running", "import progress"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        section: z
          .enum(SECTION_VALUES)
          .optional()
          .describe("One page's analysis: its own background jobs."),
      }),
      async execute(ctx, params) {
        const section = params.section ?? null;
        const { freshness, progress } = await deps.loadFreshness(ctx.projectId, section);
        const line = describeFreshness(freshness, deps.now().getTime());
        const pending = progress ? progress.pending > 0 : freshness.working;
        return {
          data: {
            updatedAt: freshness.updatedAt,
            working: freshness.working,
            importing: freshness.importing,
            line: line?.text ?? null,
            section:
              section && progress
                ? {
                    name: section,
                    lastDoneAt: progress.lastDoneAt,
                    pending: progress.pending,
                    jobKinds: sectionJobKinds(section),
                  }
                : null,
          },
          hint: pending
            ? "Analysis is in progress. Poll again in about 30 seconds, or get_job_status for the queued jobs."
            : undefined,
        };
      },
    }),
    defineOperation({
      id: "get_session",
      domain: "observability",
      title: "Get session replay",
      description:
        "One session step by step: turns, model calls, searches and tool calls, what the context held at each model call, notes on unused or missing tools and why each tool choice was good or bad, with totals. Message text only with the content opt-in. Also What-if options and past runs, read only.",
      keywords: ["session replay", "session timeline", "context at each model call", "tool choice"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        sessionId: z.string().min(1).max(256).describe("The session id, as traces carry it."),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("First step to return, for paging through a long session."),
        steps: z.number().int().min(1).max(200).default(60).describe("Steps to return (max 200)."),
        includeText: z
          .boolean()
          .default(false)
          .describe(
            "Include message text of model calls that kept it. Only honoured when the project's content opt-in is on.",
          ),
      }),
      async execute(ctx, params) {
        const actor = mcpActor(ctx.auth, ctx.projectId);
        if (!(await deps.sessionReplayEnabled(ctx.projectId, actor))) {
          throw new McpOperationError(
            "forbidden",
            "Session replay is not enabled for this organization.",
            { reason: "session_replay_off" },
          );
        }
        const organization = await requireOrganization(deps, ctx.projectId);
        const loaded = await deps.loadSession(
          ctx.projectId,
          params.sessionId,
          params.includeText ? { offset: params.offset, steps: params.steps } : null,
        );
        if (!loaded) throw notFound("session");
        const options = withSessionToolsFirst(
          await deps.loadWhatIfOptions(ctx.projectId, organization),
          loaded.tools,
        );
        const tracker = new TruncationTracker();
        const { view } = loaded;
        const window = view.rows.slice(params.offset, params.offset + params.steps);
        tracker.mark(params.offset + window.length < view.rows.length);
        const texts = loaded.readContent && params.includeText ? loaded.texts : {};
        return {
          data: {
            sessionId: view.sessionId,
            totals: { ...view.totals, costUsd: round(view.totals.costUsd, 6) },
            coverage: { counts: view.coverage.counts, text: view.coverage.text },
            gaps: view.gaps,
            contentOptIn: loaded.readContent,
            stepCount: view.rows.length,
            offset: params.offset,
            steps: window.map((row) => sessionRow(row, texts[row.index], tracker)),
            whatIf: {
              forkableCalls: loaded.forkableCalls,
              fixes: tracker.take(capRows(options.fixes, WHAT_IF_FIXES)),
              tools: tracker.take(capRows(options.tools, WHAT_IF_TOOLS)).map((tool) => ({
                name: tool.name,
                searchable: tracker.text(tool.searchable, 160),
              })),
              runs: tracker.take(capRows(loaded.runs, WHAT_IF_RUNS)),
            },
            href: sessionReplayHref(ctx.projectId, view.sessionId),
          },
          truncated: tracker.value,
          hint:
            params.offset + window.length < view.rows.length
              ? `More steps follow: call get_session again with offset ${params.offset + window.length}.`
              : loaded.readContent
                ? "get_trace opens a model call's trace."
                : "Message text is off: a project admin can turn on content reading in Settings.",
        };
      },
    }),
  ];
}
