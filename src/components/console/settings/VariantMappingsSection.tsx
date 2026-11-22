import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import { VariantMappingsForm } from "@/components/console/settings/VariantMappingsForm";
import {
  listVariantMappings,
  MAX_VARIANT_MAPPINGS,
  type StoredVariantMapping,
} from "@/lib/ingest/variants/mappings-store";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import { variantExperimentsEnabled } from "@/lib/platform/variants-flag";

const logger = getLogger("settings/variant-mappings");

/**
 * Settings > General > Variant attributes (RC-869), with
 * `FF_VARIANT_EXPERIMENTS` on: the project's own span attributes that name
 * a variant. Any member may change them. Owned (ADR-0030): the switch reads
 * the project and its organization's id, not upstream's ingest flag organization.
 */
export async function VariantMappingsSection({
  projectId,
  organization,
}: {
  projectId: string;
  organization: { id: string };
}) {
  if (!(await variantExperimentsEnabled(projectId, organization))) return null;
  const mappings = await loadMappings(projectId);
  return (
    <Section
      title="Variant attributes"
      description="Name a span attribute your agent already sends. Each value becomes a variant of the experiment you pick. A ratel.variant.name tag on the span wins."
    >
      {mappings ? (
        <VariantMappingsForm
          projectId={projectId}
          mappings={mappings.map(({ id, attributeKey, experiment }) => ({
            id,
            attributeKey,
            experiment,
          }))}
          canAdd={mappings.length < MAX_VARIANT_MAPPINGS}
        />
      ) : (
        <Callout tone="danger" title="Couldn't load variant attributes">
          Reload the page in a moment. Ingest still uses the saved mappings.
        </Callout>
      )}
    </Section>
  );
}

async function loadMappings(projectId: string): Promise<StoredVariantMapping[] | null> {
  try {
    return await listVariantMappings(projectId, getDb());
  } catch (err) {
    logger.error({ err, project_id: projectId }, "variant mappings unreadable");
    reportServerException(err, `project:${projectId}`, {
      project_id: projectId,
      operation: "variant_mappings_load",
    });
    return null;
  }
}
