import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import { ModelPricingTable } from "@/components/console/settings/ModelPricingTable";
import { type ModelPricingRow, modelPricingRows } from "@/lib/ingest/model-pricing/settings";
import { listSeenModels, loadPriceOverrides } from "@/lib/ingest/model-pricing/store";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";

const logger = getLogger("settings/model-pricing");

/**
 * Settings > General > Model pricing (RC-482). Lists only the models this
 * project's calls used, each with the price it pays.
 */
export async function ModelPricingSection({
  projectId,
  role,
}: {
  projectId: string;
  role: string;
}) {
  const rows = await loadRows(projectId);
  return (
    <Section
      title="Model pricing"
      description="What each model your agent calls costs, in USD per 1M tokens."
    >
      {rows ? (
        <ModelPricingTable projectId={projectId} rows={rows} canEdit={role === "admin"} />
      ) : (
        <Callout tone="danger" title="Couldn't load model prices">
          Reload the page in a moment. Costs elsewhere still use the saved prices.
        </Callout>
      )}
    </Section>
  );
}

async function loadRows(projectId: string): Promise<ModelPricingRow[] | null> {
  try {
    const db = getDb();
    const [seen, overrides] = await Promise.all([
      listSeenModels(projectId, db),
      loadPriceOverrides(projectId, db),
    ]);
    return modelPricingRows(seen, overrides);
  } catch (err) {
    logger.error({ err, project_id: projectId }, "model prices unreadable");
    reportServerException(err, `project:${projectId}`, {
      project_id: projectId,
      operation: "model_pricing_load",
    });
    return null;
  }
}
