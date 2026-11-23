import { permanentRedirect } from "next/navigation";
import { projectRoot } from "@/lib/console/navigation";

/**
 * No teasers (DESIGN.md, Information architecture). The nearest live thing is
 * the context split on Overview, which is what compaction would shrink.
 */
export default async function CompactionPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  permanentRedirect(`${projectRoot(projectId)}?peek=context`);
}
