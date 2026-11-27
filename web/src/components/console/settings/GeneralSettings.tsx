import { PageBody } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import type { ReactNode } from "react";
import { ContentOptInSection } from "@/components/console/session-replay/ContentOptInSection";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { GeoAttributesSection } from "./GeoAttributesSection";
import { ModelPricingSection } from "./ModelPricingSection";
import { ProjectNameForm } from "./ProjectNameForm";

/**
 * Settings > General: the project's name, its model prices, the session replay content opt-in, the
 * location attributes and, as `children`, the edition's own sections.
 */
export async function GeneralSettings({
  projectId,
  children,
}: {
  projectId: string;
  children?: ReactNode;
}) {
  // Any organization the reader belongs to, with their role there.
  const scope = await requireProjectScope(projectId);
  const { project } = scope;
  return (
    <PageBody className="*:min-w-0">
      <Section title="Project name">
        <ProjectNameForm
          currentName={project.name}
          projectId={project.id}
          canRename={scope.role === "admin"}
        />
      </Section>
      <ModelPricingSection projectId={project.id} role={scope.role} />
      <ContentOptInSection projectId={project.id} role={scope.role} />
      <GeoAttributesSection scope={scope} />
      {children}
    </PageBody>
  );
}
