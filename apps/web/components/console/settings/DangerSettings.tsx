import { PageBody } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { DeleteProject } from "./DeleteProject";
import { requireProjectScope } from "./project-scope";

/** Settings > Danger zone: deleting the project. Any member may. */
export async function DangerSettings({ projectId }: { projectId: string }) {
  const [{ project }, inSupportSession] = await Promise.all([
    requireProjectScope(projectId),
    isRestrictedBySupportSession(),
  ]);
  return (
    <PageBody className="*:min-w-0">
      <Section title="Delete project">
        <DeleteProject
          projectId={project.id}
          projectName={project.name}
          restricted={inSupportSession}
        />
      </Section>
    </PageBody>
  );
}
