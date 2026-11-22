import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { TrainingConsentPanel } from "@/components/console/fine-tuning/TrainingConsentPanel";
import { UseCasesPanel } from "@/components/console/fine-tuning/UseCasesPanel";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { getDb } from "@/lib/platform/db/client";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { loadWorkflowLabels } from "@/lib/readings/trace-signals/workflows/label-queries";
import {
  createDrizzleConsentStore,
  createDrizzleModelCallSource,
  createDrizzleUseCaseStore,
} from "@/lib/views/fine-tuning/adapters/drizzle-store";
import { consentText } from "@/lib/views/fine-tuning/consent-api";
import { consentView } from "@/lib/views/fine-tuning/domain/consent";
import { DEFAULT_WINDOW_DAYS } from "@/lib/views/fine-tuning/domain/use-case";
import { loadUseCaseStats } from "@/lib/views/fine-tuning/resolve";
import { viewOfUseCase } from "@/lib/views/fine-tuning/use-cases-api";
import { resolveFineTuningPageEntry } from "./context";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fine-tuning" };

/** Fine-tuning datasets from a project's traces (RC-1123), behind `FF_FINE_TUNING`. */
export default async function FineTuningPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const entry = await resolveFineTuningPageEntry(projectId);
  if (entry.kind === "no_database") {
    return (
      <DatabaseUnavailable title="Fine-tuning">
        Fine-tuning becomes available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const { project, isAdmin, now } = entry.context;
  const db = getDb();
  const since = new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
  const [consent, useCases, taskOptions, labels] = await Promise.all([
    createDrizzleConsentStore(db).getActiveConsent(project.id).then(consentView),
    createDrizzleUseCaseStore(db).listUseCases(project.id),
    createDrizzleModelCallSource(db).recentTasks(project.id, since),
    loadWorkflowLabels(project.id, db),
  ]);
  const taskNames = Object.fromEntries([...labels].map(([id, label]) => [id, label.name]));
  const source = createDrizzleModelCallSource(db);
  // A use case whose stats fail still lists, with dashes: the failure is logged and reported.
  const rows = await Promise.all(
    useCases.map(async (useCase) => ({
      ...viewOfUseCase(useCase),
      stats: await loadOrFallback({
        operation: "fine_tuning_use_case_stats",
        distinctId: `project:${project.id}`,
        fallback: null,
        load: () => loadUseCaseStats(project.id, useCase.selector, source, now),
      }),
    })),
  );
  const apiRoot = `/api/projects/${encodeURIComponent(project.id)}/fine-tuning`;

  return (
    <Page>
      <PageHeader
        title="Fine-tuning"
        description="Turn the model calls of one job into a dataset for a smaller model."
      />
      <PageBody>
        <TrainingConsentPanel
          apiHref={`${apiRoot}/consent`}
          consent={consent}
          text={consentText()}
          canEdit={isAdmin}
        />
        <UseCasesPanel
          apiHref={`${apiRoot}/use-cases`}
          useCases={rows}
          taskOptions={taskOptions}
          taskNames={taskNames}
        />
      </PageBody>
    </Page>
  );
}
