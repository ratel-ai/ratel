import { PageBody } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { ContentOptInSection } from "@/components/console/session-replay/ContentOptInSection";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { ModelPricingSection } from "./ModelPricingSection";
import { ProjectNameForm } from "./ProjectNameForm";
import { VariantMappingsSection } from "./VariantMappingsSection";

/**
 * Settings > General: the project's name, its model prices, the session replay content opt-in
 * and, with `FF_VARIANT_EXPERIMENTS` on, the variant attributes (RC-869).
 */
export async function GeneralSettings({ projectId }: { projectId: string }) {
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
      <VariantMappingsSection projectId={project.id} organization={scope.organization} />
    </PageBody>
  );
}
