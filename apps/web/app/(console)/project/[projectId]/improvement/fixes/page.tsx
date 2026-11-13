import { loadFixesPage } from "@/app/(console)/project/[projectId]/improvement/fixes/data";
import { FixesNoDatabase, FixesPage } from "@/components/console/fixes/FixesPage";
import { stageSpineEnabled } from "@/lib/views/stage-spine-flag";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fixes" };

/**
 * Improvements, Fixes: one list of the changes that would make the agent
 * better, whatever found them. Filters (`?kind=`, `?task=`, `?tool=`,
 * `?topic=`) and the open fix (`?peek=`) live in the URL and are read on
 * the client. Owned (ADR-0030): no Cloud flag gate; the task simulation links
 * need `FF_EVAL_GATE` (the eval badges) and `FF_STAGE_SPINE`.
 */
export default async function FixesRoute({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const data = await loadFixesPage(projectId);
  if (data.kind === "no-db") return <FixesNoDatabase />;
  return (
    <FixesPage
      projectId={data.projectId}
      model={data.model}
      now={data.now}
      evalBadges={data.evalBadges}
      shipped={data.shipped}
      taskSimulations={data.evalBadges !== null && stageSpineEnabled()}
      progress={data.progress}
    />
  );
}
