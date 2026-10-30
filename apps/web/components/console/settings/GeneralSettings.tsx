import { PageBody } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { notFound } from "next/navigation";
import { findProject } from "@/lib/console/navigation";
import { getConsoleScope } from "@/lib/console/shell-data";
import { ProjectNameForm } from "./ProjectNameForm";

/** Settings > General: the project's name, and nothing else. */
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
    </PageBody>
  );
}
