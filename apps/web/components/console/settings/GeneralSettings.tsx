import { PageBody } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { notFound } from "next/navigation";
import { ContentOptInSection } from "@/components/console/session-replay/ContentOptInSection";
import { findProject } from "@/lib/console/navigation";
import { getConsoleScope } from "@/lib/console/shell-data";
import { ModelPricingSection } from "./ModelPricingSection";
import { ProjectNameForm } from "./ProjectNameForm";

/** Settings > General: the project's name, its model prices and the session replay content opt-in, each when its flag is on. */
export async function GeneralSettings({ projectId }: { projectId: string }) {
  const scope = await getConsoleScope();
  const project = findProject(scope?.projects ?? [], projectId);
  if (!scope || !project) notFound();
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
    </PageBody>
  );
}
