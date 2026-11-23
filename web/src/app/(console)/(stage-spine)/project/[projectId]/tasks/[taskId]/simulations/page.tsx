import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { taskSimulationListFor } from "@/lib/views/task-evals/simulation-page";
import { topLevelTasksHref } from "@/lib/views/tasks/paths";
import { simulationPageContext } from "./context";
import { SimulationList } from "./SimulationList";

export const dynamic = "force-dynamic";
export const metadata = { title: "Task simulations" };

export default async function TaskSimulationsPage({
  params,
}: {
  params: Promise<{ projectId: string; taskId: string }>;
}) {
  const { projectId, taskId } = await params;
  const { project, task, fixes } = await simulationPageContext(projectId, taskId);
  const rows = await taskSimulationListFor(project.id, taskId, fixes);
  return (
    <Page>
      <PageHeader
        title="Simulations"
        crumbs={[{ label: task.name, href: topLevelTasksHref(project.id, taskId) }]}
        description="Test each fix on this task's past runs before you change your agent."
      />
      <PageBody wide>
        <SimulationList projectId={project.id} taskId={taskId} rows={rows} />
      </PageBody>
    </Page>
  );
}
