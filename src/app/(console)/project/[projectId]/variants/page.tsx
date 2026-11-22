import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { VariantExperimentsView } from "@/components/console/variants/VariantExperimentsView";
import { isDbConfigured } from "@/lib/platform/db/client";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import {
  listVariantExperiments,
  type VariantExperimentList,
} from "@/lib/views/variants/compare-service";
import { variantExperimentHref } from "@/lib/views/variants/paths";
import { resolveVariantsPageContext, type VariantsSearchParams } from "./context";

export const dynamic = "force-dynamic";
export const metadata = { title: "Variants" };

/** The project's variant experiments (RC-871), behind `cloud-variant-experiments`. */
export default async function VariantsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<VariantsSearchParams>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Variants">
        Variants become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const { projectId } = await params;
  const { project, range, window, clamped, query } = await resolveVariantsPageContext(
    projectId,
    await searchParams,
  );

  const list = await loadOrFallback<VariantExperimentList | null>({
    operation: "variant_experiments_list",
    distinctId: `project:${project.id}`,
    fallback: null,
    load: () => listVariantExperiments(project.id, window),
  });

  return (
    <VariantExperimentsView
      now={new Date().toISOString()}
      experiments={
        list?.experiments.map((experiment) => ({
          ...experiment,
          href: variantExperimentHref(project.id, experiment.experiment, query),
        })) ?? null
      }
      truncated={list?.truncated ?? false}
      range={{ preset: range.preset, from: range.from, to: range.to }}
      clamped={clamped}
    />
  );
}
