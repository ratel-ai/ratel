import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { notFound, redirect } from "next/navigation";
import { ConnectRunner } from "@/components/console/sandboxes/ConnectRunner";
import { RunnerStatus } from "@/components/console/sandboxes/RunnerStatus";
import { SandboxesList } from "@/components/console/sandboxes/SandboxesList";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { sandboxesEnabledForProject } from "@/lib/platform/sandboxes-flag";
import { getSessionContext } from "@/lib/platform/session";
import { loadSandboxesPage } from "@/lib/views/sandboxes/page";
import { sandboxesPageDeps } from "@/lib/views/sandboxes/page-deps";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sandboxes" };

/** The sandboxes of the caller's `ratel sandbox dev` runner (RC-1102). 404 unless `cloud-sandboxes` is on. */
export default async function SandboxesPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  if (!isDbConfigured()) notFound();
  const context = await getSessionContext();
  if (!context) redirect("/");
  const { projectId } = await params;
  const { project } = await getProjectScope(projectId);
  if (!(await sandboxesEnabledForProject(project.id))) notFound();
  const model = await loadSandboxesPage(
    { projectId: project.id, externalId: context.user.externalId },
    sandboxesPageDeps,
  );

  return (
    <Page>
      <PageHeader
        title="Sandboxes"
        description="Run your agent code with a changed model, prompt or param, and see the real output."
        actions={<RunnerStatus runner={model.runner} />}
      />
      <PageBody>
        {model.runner && model.runner.online ? (
          <SandboxesList projectId={project.id} sandboxes={model.sandboxes} paused={false} />
        ) : (
          <>
            <ConnectRunner paused={model.runner !== null} />
            {model.sandboxes.length > 0 ? (
              <Section title="Sandboxes of your paused runner">
                <SandboxesList projectId={project.id} sandboxes={model.sandboxes} paused />
              </Section>
            ) : null}
          </>
        )}
      </PageBody>
    </Page>
  );
}
