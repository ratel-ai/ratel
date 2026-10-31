import { redirect } from "next/navigation";
import { agentHealthRedirectTarget } from "@/lib/readings/trace-signals/view";

/**
 * Agent health used to live under Continuous improvement. It is a top-level
 * project page now (`/project/<id>/health`); this keeps old links and
 * bookmarks working, window and all. A temporary redirect, so a browser does
 * not pin the move while the page is still behind its flag.
 */
export default async function LegacyAgentHealthPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, search] = await Promise.all([params, searchParams]);
  redirect(agentHealthRedirectTarget(projectId, search));
}
