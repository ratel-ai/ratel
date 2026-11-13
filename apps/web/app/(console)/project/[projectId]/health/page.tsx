import {
  type SummaryImports,
  SummaryNoDatabase,
  SummaryView,
} from "@/components/console/health/v2/SummaryView";
import { composition } from "@/lib/composition";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import type { EditionUi } from "@/lib/contracts/composition";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { trackProductEvent } from "@/lib/platform/telemetry";
import {
  applyPlanLimits,
  hasSignals,
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
 * Owned (ADR-0030): the project comes from the console scope (the session's
 * organization, a 404 otherwise); the limits from the entitlements port.
 * No share link or plan to pick here; the importer is the edition's.
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
  const importsSlot = (await composition.ui?.())?.HealthImports;
  const [loaded, imports, tasks, fixes, corrections] = await Promise.all([
    loadOrFallback({
      operation: "agent_health_model",
      distinctId,
      fallback: fallbackModel,
      // Example turns are not read with the page: an issue reads its own when opened.
      load: () =>
        loadHealthPageModel({ projectId: project.id, windowDays }, process.env.NODE_ENV, {
          getLimits: async () => ({ ...limits, agentHealthEvidenceTurns: 0 }),
        }),
    }),
    loadImportState(project.id, importsSlot),
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
    readOnly: false,
  });

  // Best-effort analytics through the telemetry port; a failure never reaches the page.
  await trackProductEvent(
    "health_viewed",
    { externalId: user.externalId, orgId: organization.id, projectId: project.id },
    {
      has_signals: hasSignals(model),
      capture_level: model.captureLevel,
      ...(state ? { page_state: state.kind } : {}),
    },
  );

  return (
    <SummaryView
      projectId={project.id}
      projectName={project.name}
      model={model}
      state={state}
      windowOptions={windowOptionsForPlan(limits.agentHealthWindowDays)}
      tasks={tasks}
      fixes={fixes}
      corrections={corrections}
      reportHref={healthReportHref(project.id, windowDays)}
      imports={imports}
    />
  );
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
