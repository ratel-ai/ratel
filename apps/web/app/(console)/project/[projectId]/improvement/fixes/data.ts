import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { loadFixes } from "@/lib/views/fixes/load";
import type { FixesModel } from "@/lib/views/fixes/types";
import type { SectionProgress } from "@/lib/views/freshness/model";
import { loadPageProgress } from "@/lib/views/freshness/page";

export type FixesPageData =
  | { kind: "no-db" }
  | {
      kind: "ready";
      projectId: string;
      model: FixesModel;
      now: string;
      /** Where the jobs that find fixes stand; null when the read failed. */
      progress: SectionProgress | null;
    };

/**
 * What Fixes reads: the scope, then every source of fixes (`loadFixes`,
 * where each one degrades on its own). On for every project: no flag.
 * Owned (ADR-0030): the project comes from the console scope, a 404 otherwise.
 */
export async function loadFixesPage(projectId: string): Promise<FixesPageData> {
  if (!isDbConfigured()) return { kind: "no-db" };
  const { project, organization } = await requireProjectScope(projectId);
  const now = new Date();
  const [model, progress] = await Promise.all([
    loadFixes({ projectId: project.id, organization, now }),
    loadPageProgress(project.id, "fixes"),
  ]);
  return { kind: "ready", projectId: project.id, model, now: now.toISOString(), progress };
}
