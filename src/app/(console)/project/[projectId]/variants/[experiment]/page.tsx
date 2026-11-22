import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { VariantComparisonView } from "@/components/console/variants/VariantComparisonView";
import { isDbConfigured } from "@/lib/platform/db/client";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { afterOutsideSupportSession } from "@/lib/platform/support-session";
import { trackProductEvent } from "@/lib/platform/telemetry";
import {
  getVariantComparison,
  type VariantComparisonResult,
} from "@/lib/views/variants/compare-service";
import { variantsHref } from "@/lib/views/variants/paths";
import { resolveVariantsPageContext, type VariantsSearchParams } from "../context";

export const dynamic = "force-dynamic";
export const metadata = { title: "Variant experiment" };

const FAILED = Symbol("failed");

/** One variant experiment (RC-871): the experiment name is the URL segment. */
export default async function VariantExperimentPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; experiment: string }>;
  searchParams: Promise<VariantsSearchParams>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Variants">
        Variants become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const { projectId, experiment: segment } = await params;
  const context = await resolveVariantsPageContext(projectId, await searchParams);
  const { project, organization, range, window, clamped, query } = context;
  const experiment = decodeURIComponent(segment);

  const loaded = await loadOrFallback<VariantComparisonResult | null | typeof FAILED>({
    operation: "variant_experiment_compare",
    distinctId: `project:${project.id}`,
    fallback: FAILED,
    load: () => getVariantComparison(project.id, experiment, window),
  });
  const comparison = loaded === FAILED ? null : loaded;

  if (comparison) {
    await afterOutsideSupportSession(() =>
      trackProductEvent(
        "variant_experiment_viewed",
        { externalId: context.externalId, orgId: organization.id, projectId: project.id },
        {
          variants: comparison.variants.length,
          suggestions: comparison.suggestions.length,
          below_minimum: comparison.variants.filter((variant) => variant.belowMinimumSample).length,
          baseline_reason: comparison.baseline?.reason ?? "none",
        },
      ),
    );
  }

  return (
    <VariantComparisonView
      experiment={experiment}
      comparison={comparison}
      failed={loaded === FAILED}
      listHref={variantsHref(project.id, query)}
      range={{ preset: range.preset, from: range.from, to: range.to }}
      clamped={clamped}
    />
  );
}
