import { Section } from "@ratel/design-system/section";
import type { ProjectScope } from "@/lib/console/scope/project-scope";
import { loadGeoAttributes } from "@/lib/ingest/geo/store";
import { GeoAttributesForm } from "./GeoAttributesForm";

/** The location attributes of Settings > General. */
export async function GeoAttributesSection({
  scope: { project, role },
}: {
  scope: Pick<ProjectScope, "project" | "role">;
}) {
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
