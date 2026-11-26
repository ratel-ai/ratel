import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Callout } from "@ratel/design-system/states";
import { redirect } from "next/navigation";
import { fixLookups } from "@/components/console/health/v2/summary-model";
import { fixActions } from "@/components/console/self-corrections/fix-actions";
import {
  SELF_CORRECTIONS_DESCRIPTION,
  SelfCorrectionsView,
} from "@/components/console/self-corrections/SelfCorrectionsView";
import { focusedConsoleEnabled } from "@/lib/console/focused-console";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { dbConfigured } from "@/lib/platform/db/request";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { parseWindowDays, windowOptionsForPlan } from "@/lib/readings/trace-signals/view";
import { loadFixes } from "@/lib/views/fixes/load";
import type { FixesModel } from "@/lib/views/fixes/types";
import { loadPageProgress } from "@/lib/views/freshness/page";
import {
  loadSelfCorrectionsPage,
  unavailableSelfCorrectionsPage,
} from "@/lib/views/health/self-corrections/page-load";
import {
  NO_FILTERS,
  parseFilters,
  selfCorrectionsHref,
} from "@/lib/views/health/self-corrections/paths";
import {
  type SelfCorrectionsAddress,
  selfCorrectionsRedirect,
} from "@/lib/views/health/self-corrections/routes";

/**
 * Self-corrections: how often the agent goes back on itself, where, what it said,
 * and what to change. Fixes are read beside the page so each fix opens where it is made; a
 * failed read of Fixes costs only those links. Owned (ADR-0004): the project comes from the
 * console scope.
 *
 * Two addresses answer: `/self-corrections` with `focusedConsole` on for the project's
 * organization, `/health/self-corrections` without it. Each redirects to the other, query kept,
 * when the flag says so.
 */
export async function SelfCorrectionsRoute({
  address,
  params,
  searchParams,
}: {
  address: SelfCorrectionsAddress;
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (!(await dbConfigured())) {
    return (
      <Page>
        <PageHeader title="Self-corrections" description={SELF_CORRECTIONS_DESCRIPTION} />
        <PageBody>
          <Callout title="No database connected yet">
            Self-corrections become available once setup finishes.
          </Callout>
        </PageBody>
      </Page>
    );
  }

  const { project, organization } = await requireProjectScope(projectId);
  const search = await searchParams;
  const focused = await focusedConsoleEnabled(organization);
  const moved = selfCorrectionsRedirect(address, focused, project.id, search);
  if (moved) redirect(moved);
  const limits = getAgentHealthLimits(organization);
  const windowDays = parseWindowDays(search.days, limits.agentHealthWindowDays);
  const filters = parseFilters(search);

  const distinctId = `project:${project.id}`;
  const [model, fixes, progress] = await Promise.all([
    loadOrFallback({
      operation: "self_corrections_page",
      distinctId,
      fallback: unavailableSelfCorrectionsPage(project.id, windowDays, filters),
      load: () => loadSelfCorrectionsPage({ projectId: project.id, windowDays, filters }),
    }),
    loadOrFallback<Pick<FixesModel, "open" | "applied"> | null>({
      operation: "self_corrections_fixes",
      distinctId,
      fallback: null,
      load: () => loadFixes({ projectId: project.id, organization, topics: false }),
    }),
    loadPageProgress(project.id, "self_corrections"),
  ]);

  const windows = windowOptionsForPlan(limits.agentHealthWindowDays)
    .filter((option) => !option.locked)
    .map((option) => ({
      href: selfCorrectionsHref(project.id, { days: option.days, filters }),
      label: `${option.days} days`,
      active: option.days === windowDays,
    }));

  return (
    <SelfCorrectionsView
      model={model}
      windows={windows}
      clearHref={selfCorrectionsHref(project.id, { days: windowDays, filters: NO_FILTERS })}
      now={new Date().toISOString()}
      actions={fixActions(project.id, model.fixes, fixLookups(fixes))}
      progress={progress}
      topLevel={focused}
    />
  );
}
