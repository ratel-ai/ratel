import {
  type SummaryImports,
  SummaryNoDatabase,
  type SummaryShare,
  SummaryView,
} from "@/components/console/health/v2/SummaryView";
import { composition } from "@/lib/composition";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import type { EditionUi } from "@/lib/contracts/composition";
import { isDbConfigured } from "@/lib/platform/db/client";
import {
  billingSelfServe,
  fullAgentHealthPlanName,
  getAgentHealthLimits,
} from "@/lib/platform/entitlements";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import {
  afterOutsideSupportSession,
  isRestrictedBySupportSession,
} from "@/lib/platform/support-session";
import { trackProductEvent } from "@/lib/platform/telemetry";
import {
  type InferredToolShare,
  loadInferredToolShare,
  toolCallsInferred,
} from "@/lib/readings/trace-signals/inferred-tools-query";
import { type PartialReading, partialReading } from "@/lib/readings/trace-signals/partial-reading";
import { loadPartialFacts } from "@/lib/readings/trace-signals/partial-reading-query";
import { toolRunInsightsEnabled } from "@/lib/readings/trace-signals/tool-run-insights";
import {
  applyPlanLimits,
  hasSignals,
  LOW_CONFIDENCE_FLOOR,
  parseWindowDays,
  windowOptionsForPlan,
} from "@/lib/readings/trace-signals/view";
import { loadFixes } from "@/lib/views/fixes/load";
import type { FixesModel } from "@/lib/views/fixes/types";
import { turnsPerIssue } from "@/lib/views/health/issue-examples";
import { loadHealthPageModel, pendingHealthModel } from "@/lib/views/health/page-model";
import { loadHealthPageState } from "@/lib/views/health/page-state-load";
import { healthReportHref } from "@/lib/views/health/report-href";
import {
  loadSelfCorrectionsCard,
  unavailableSelfCorrectionsCard,
} from "@/lib/views/health/self-corrections/card";
import { shareLinkOnPlan } from "@/lib/views/health/share-window";
import { buildTaskList, type TaskListModel } from "@/lib/views/tasks/model";
import { loadTasksInputs } from "@/lib/views/tasks/page-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agent health" };

/**
 * Agent health's Summary: what the agent gets wrong and what to change. The
 * reading (without example turns: an issue reads its own when it is opened),
 * the decided state of the window, and its neighbours: the tasks, the fixes
 * the issues open, and self-corrections. Each read degrades on its own.
 *
 * Owned (ADR-0004): the project comes from the console scope (the session's
 * organization, a 404 otherwise); the limits and plans from the entitlements port.
 * The importer and the share dialog are the edition's.
 */
export default async function AgentHealthPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (!isDbConfigured()) return <SummaryNoDatabase />;

  const { project, organization, user } = await requireProjectScope(projectId);
  const limits = getAgentHealthLimits(organization);
  const windowDays = parseWindowDays((await searchParams).days, limits.agentHealthWindowDays);
  const distinctId = `project:${project.id}`;
  // Kept by identity: a model that is this fallback is a failed read, not an empty project.
  const fallbackModel = pendingHealthModel(windowDays);
  const billingEnabled = billingSelfServe(organization);
  const editionUi = await composition.ui?.();
  const importsSlot = editionUi?.HealthImports;
  // toolRunInsights (RC-828): a reading from 10 turns on shows, marked low confidence.
  const lowConfidenceFloor = (await toolRunInsightsEnabled(project.id, organization))
    ? LOW_CONFIDENCE_FLOOR
    : undefined;
  const [loaded, imports, share, inSupportSession, tasks, fixes, corrections] = await Promise.all([
    loadOrFallback({
      operation: "agent_health_model",
      distinctId,
      fallback: fallbackModel,
      // Example turns are not read with the page: an issue reads its own when opened.
      load: () =>
        loadHealthPageModel(
          { projectId: project.id, windowDays, lowConfidenceFloor },
          process.env.NODE_ENV,
          {
            getLimits: async () => ({ ...limits, agentHealthEvidenceTurns: 0 }),
          },
        ),
    }),
    loadImportState(project.id, importsSlot),
    loadShareState(project.id, editionUi?.HealthShare, limits.agentHealthWindowDays),
    isRestrictedBySupportSession(),
    loadOrFallback<TaskListModel | null>({
      operation: "agent_health_tasks",
      distinctId,
      fallback: null,
      load: async () => buildTaskList(await loadTasksInputs(project.id)),
    }),
    loadOrFallback<Pick<FixesModel, "open" | "applied"> | null>({
      operation: "agent_health_fixes",
      distinctId,
      fallback: null,
      load: () => loadFixes({ projectId: project.id, organization, topics: false }),
    }),
    loadOrFallback({
      operation: "agent_health_self_corrections_card",
      distinctId,
      fallback: unavailableSelfCorrectionsCard(project.id, windowDays),
      load: () => loadSelfCorrectionsCard(project.id, windowDays),
    }),
  ]);
  // The example allowance, kept for when an issue is opened (the model carries none).
  const model = {
    ...applyPlanLimits(loaded, limits),
    evidenceTurnsPerSignal: turnsPerIssue(limits.agentHealthEvidenceTurns),
  };
  const state = await loadHealthPageState({
    projectId: project.id,
    organizationId: organization.id,
    model,
    modelUnavailable: loaded === fallbackModel,
    // A failed read is unknown, not "no imports": a held one may be in there.
    // Without an edition importer: none, which the state reads as none.
    imports: imports ? imports.list : importsSlot ? null : [],
    planWindowDays: limits.agentHealthWindowDays,
    // An operator's view queues no reading.
    readOnly: inSupportSession,
  });

  // Imported runs with no tool calls: read what their spans still say.
  const partial =
    state?.kind === "imported_no_tools"
      ? await loadOrFallback<PartialReading | null>({
          operation: "agent_health_partial_reading",
          distinctId,
          fallback: null,
          load: async () =>
            partialReading(
              await loadPartialFacts(project.id, { now: new Date(), windowDays }),
              windowDays,
            ),
        })
      : null;

  // Tool calls inferred from imported span shape: the Ready page says what was inferred and what is missing.
  // Owned: upstream asks only a project with runs from the one importer that infers them; the
  // edition names its sources, so here any project with imported runs is asked.
  const inferredTools =
    state?.kind === "ready" && (imports?.list.some((item) => item.runsImported > 0) ?? false)
      ? toolCallsInferred(
          await loadOrFallback<InferredToolShare | null>({
            operation: "agent_health_inferred_tools",
            distinctId,
            fallback: null,
            load: () => loadInferredToolShare(project.id, { now: new Date(), windowDays }),
          }),
        )
      : false;

  // Best-effort analytics after the response streams. Never inside an admin
  // support session: the event would describe the operator, or the customer
  // they are viewing as, doing something they did not.
  await afterOutsideSupportSession(() =>
    trackProductEvent(
      "health_viewed",
      { externalId: user.externalId, orgId: organization.id, projectId: project.id },
      {
        has_signals: hasSignals(model),
        capture_level: model.captureLevel,
        ...(state ? { page_state: state.kind } : {}),
        ...(partial ? { partial_reading: true } : {}),
        ...(inferredTools ? { inferred_tools: true } : {}),
      },
    ),
  );

  return (
    <SummaryView
      projectId={project.id}
      projectName={project.name}
      model={model}
      state={state}
      windowOptions={windowOptionsForPlan(limits.agentHealthWindowDays)}
      billingHref={billingEnabled ? `/org/${encodeURIComponent(organization.slug)}/billing` : null}
      lockedPlan={fullAgentHealthPlanName()}
      tasks={tasks}
      fixes={fixes}
      corrections={corrections}
      reportHref={healthReportHref(project.id, windowDays)}
      imports={imports}
      share={share}
      partial={partial}
      inferredTools={inferredTools}
    />
  );
}

/**
 * The project's public link, its window cut to the plan as the public page opens it. A failed
 * read hides sharing, not the page.
 */
async function loadShareState(
  projectId: string,
  slot: EditionUi["HealthShare"],
  planWindowDays: number,
): Promise<SummaryShare | null> {
  if (!slot) return null;
  return loadOrFallback<SummaryShare | null>({
    operation: "agent_health_share_state",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: async () => {
      const state = await slot.load(projectId);
      return (
        state && {
          ...state,
          link: shareLinkOnPlan(state.link, planWindowDays),
          Dialog: slot.Dialog,
        }
      );
    },
  });
}

/** The project's recent imports. A failed read hides the importer, not the page. */
async function loadImportState(
  projectId: string,
  slot: EditionUi["HealthImports"],
): Promise<SummaryImports | null> {
  if (!slot) return null;
  return loadOrFallback<SummaryImports | null>({
    operation: "agent_health_import_state",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: async () => ({
      ...(await slot.load(projectId)),
      sourceLabel: slot.sourceLabel,
      Importer: slot.Importer,
    }),
  });
}
