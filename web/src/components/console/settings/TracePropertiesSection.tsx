import { Section } from "@ratel/design-system/section";
import type { ProjectScope } from "@/lib/console/scope/project-scope";
import { listTraceProperties } from "@/lib/ingest/properties/store";
import { TracePropertiesTable } from "./TracePropertiesTable";

/** The trace properties of Settings > General (RTL-395). */
export async function TracePropertiesSection({
  scope: { project, role },
}: {
  scope: Pick<ProjectScope, "project" | "role">;
}) {
  return (
    // The forms link here with ?property=<name>#trace-properties: the table opens on that property.
    <div id="trace-properties" className="scroll-mt-6">
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
    </div>
  );
}
