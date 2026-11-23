import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { notFound } from "next/navigation";
import { fixIdFromSegment } from "@/lib/views/eval-gate/view";
import { findFix } from "@/lib/views/fixes/select";
import { taskSimulationDetailFor } from "@/lib/views/task-evals/simulation-page";
import { simulationPageContext } from "../context";
import { SimulationDetail } from "../SimulationDetail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Task simulation" };

export default async function TaskSimulationPage({
  params,
}: {
  params: Promise<{ projectId: string; taskId: string; fixId: string }>;
}) {
  const { projectId, taskId, fixId } = await params;
  const { project, fixes } = await simulationPageContext(projectId, taskId);
  const fix = findFix(fixes, fixIdFromSegment(fixId));
  if (!fix || !fix.subject.tasks.some((task) => task.id === taskId)) notFound();
  const model = await taskSimulationDetailFor(project.id, taskId, fix);
  return (
    <Page>
      <PageHeader
        title={fix.short}
        crumbs={[
          {
            label: "Simulations",
            href: `/project/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(taskId)}/simulations`,
          },
        ]}
        description={fix.title}
      />
      <PageBody>
        <SimulationDetail model={model} />
      </PageBody>
    </Page>
  );
}
