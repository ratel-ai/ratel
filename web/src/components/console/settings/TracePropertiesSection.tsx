import { Section } from "@ratel/design-system/section";
import type { ProjectScope } from "@/lib/console/scope/project-scope";
import { listTraceProperties } from "@/lib/ingest/properties/store";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { TracePropertiesTable } from "./TracePropertiesTable";

/** The trace properties of Settings > General (RTL-395), with `customMonitoring` on. */
export async function TracePropertiesSection({
  scope: { project, organization, role },
}: {
  scope: Pick<ProjectScope, "project" | "organization" | "role">;
}) {
  if (!(await featureEnabled("customMonitoring", { organizationId: organization.id }))) return null;
  return (
    <Section
      title="Trace properties"
      description="The attribute keys your traces carry. An indexed property keeps its value on each trace, for filters and group-bys."
    >
      <TracePropertiesTable
        projectId={project.id}
        rows={await listTraceProperties(project.id)}
        canChange={role === "admin"}
      />
    </Section>
  );
}
