import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { loadFixes } from "@/lib/views/fixes/load";
import type { FixesModel } from "@/lib/views/fixes/types";

export type FixesPageData =
  | { kind: "no-db" }
  | { kind: "ready"; projectId: string; model: FixesModel; now: string };

/**
 * What Fixes reads: the scope, then every source of fixes (`loadFixes`,
 * where each one degrades on its own). On for every project: no flag.
 * Owned (ADR-0030): the project comes from the console scope, a 404 otherwise.
 */
export async function loadFixesPage(projectId: string): Promise<FixesPageData> {
  if (!isDbConfigured()) return { kind: "no-db" };
  const { project, organization } = await requireProjectScope(projectId);
  const now = new Date();
  const model = await loadFixes({ projectId: project.id, organization, now });
  return { kind: "ready", projectId: project.id, model, now: now.toISOString() };
}
