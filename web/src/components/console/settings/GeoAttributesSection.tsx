import { Section } from "@ratel/design-system/section";
import type { ProjectScope } from "@/lib/console/scope/project-scope";
import { loadGeoAttributes } from "@/lib/ingest/geo/store";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { GeoAttributesForm } from "./GeoAttributesForm";

/** The location attributes of Settings > General, with `customMonitoring` on. */
export async function GeoAttributesSection({
  scope: { project, organization, role },
}: {
  scope: Pick<ProjectScope, "project" | "organization" | "role">;
}) {
  if (!(await featureEnabled("customMonitoring", { organizationId: organization.id }))) return null;
  return (
    <Section title="Location attributes">
      <GeoAttributesForm
        projectId={project.id}
        initial={await loadGeoAttributes(project.id)}
        canChange={role === "admin"}
      />
    </Section>
  );
}
