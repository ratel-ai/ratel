import { redirect } from "next/navigation";
import { projectRoot } from "@/lib/console/navigation";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { insightsRedirectTarget } from "@/lib/readings/trace-signals/view";

/**
 * Agent health is what the Insights teaser promised, so an old link lands
 * there, and on Overview otherwise (no teasers, DESIGN.md). Owned (ADR-0030):
 * the project comes from the console scope, and Agent health is always on in
 * this edition, so no flag decides where it lands.
 */
async function agentHealthRedirect(projectId: string): Promise<string | null> {
  if (!isDbConfigured()) return null;
  const scope = await findProjectScope(projectId);
  if (!scope) return null;
  return insightsRedirectTarget(scope.project.id, true);
}

export default async function InsightsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  redirect((await agentHealthRedirect(projectId)) ?? projectRoot(projectId));
}
