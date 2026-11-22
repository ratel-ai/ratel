import { PageHeader } from "@ratel/design-system/page-header";
import { TabNav } from "@ratel/design-system/tabs";
import { evalsHref } from "@/lib/views/evals/paths";
import { RunAllButton } from "./RunAllButton";

/** The Evals page header (RC-291): Run all, and the Evals and Runs tabs (C1). */
export function EvalsHeader({
  projectId,
  evalCount,
  runCount,
  task,
}: {
  projectId: string;
  evalCount: number;
  runCount: number;
  task?: string | null;
}) {
  return (
    <PageHeader
      title="Evals"
      actions={
        <RunAllButton projectId={projectId} task={task ?? null} disabled={evalCount === 0} />
      }
      tabs={
        <TabNav
          label="Evals"
          tabs={[
            { href: evalsHref(projectId), label: "Evals", meta: evalCount, exact: true },
            { href: evalsHref(projectId, { tab: "runs" }), label: "Runs", meta: runCount },
          ]}
        />
      }
    />
  );
}
