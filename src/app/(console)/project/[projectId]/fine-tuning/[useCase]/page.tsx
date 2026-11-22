import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { notFound } from "next/navigation";
import {
  DatasetBuildForm,
  DatasetSummary,
  DatasetVersions,
} from "@/components/console/fine-tuning/DatasetsPanel";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { getDb } from "@/lib/platform/db/client";
import { createDrizzleDatasetStore } from "@/lib/views/fine-tuning/adapters/drizzle-dataset-store";
import {
  createDrizzleConsentStore,
  createDrizzleUseCaseStore,
} from "@/lib/views/fine-tuning/adapters/drizzle-store";
import { viewOfDataset } from "@/lib/views/fine-tuning/domain/dataset";
import { resolveFineTuningPageEntry } from "../context";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fine-tuning use case" };

/** One use case (RC-1129): build a dataset version, watch it build, read its summary. Behind `FF_FINE_TUNING`. */
export default async function FineTuningUseCasePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; useCase: string }>;
  searchParams: Promise<{ dataset?: string | string[] }>;
}) {
  const [{ projectId, useCase: useCaseId }, query] = await Promise.all([params, searchParams]);
  const entry = await resolveFineTuningPageEntry(projectId);
  if (entry.kind === "no_database") {
    return (
      <DatabaseUnavailable title="Fine-tuning">
        Fine-tuning becomes available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const { project } = entry.context;
  const db = getDb();
  const useCase = await createDrizzleUseCaseStore(db).getUseCase(project.id, useCaseId);
  if (!useCase) notFound();
  const [consent, datasets] = await Promise.all([
    createDrizzleConsentStore(db).getActiveConsent(project.id),
    createDrizzleDatasetStore(db).listDatasets(project.id, useCase.id),
  ]);
  const views = datasets.map(viewOfDataset);
  const asked = typeof query.dataset === "string" ? query.dataset : null;
  const selected = views.find((dataset) => dataset.id === asked) ?? views[0] ?? null;
  const pageRoot = `/project/${encodeURIComponent(project.id)}/fine-tuning`;
  const apiHref = `/api/projects/${encodeURIComponent(project.id)}/fine-tuning/use-cases/${encodeURIComponent(useCase.id)}/datasets`;

  return (
    <Page>
      <PageHeader
        title={useCase.name}
        description="Build a redacted dataset from this use case's model calls, then check what went in."
        crumbs={[{ label: "Fine-tuning", href: pageRoot }]}
      />
      <PageBody>
        <DatasetBuildForm
          apiHref={apiHref}
          consentGiven={consent !== null}
          consentHref={`${pageRoot}#training-opt-in`}
        />
        <DatasetVersions datasets={views} selectedId={selected?.id ?? null} />
        {selected ? <DatasetSummary dataset={selected} /> : null}
      </PageBody>
    </Page>
  );
}
