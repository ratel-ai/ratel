import type { FixLookup } from "@/components/console/health/v2/issue-rows";
import { fixHref } from "@/lib/views/fixes/href";
import { findFix } from "@/lib/views/fixes/select";
import type { FixView } from "@/lib/views/health/self-corrections/page-model";
import { descriptionFixHref, isDescriptionFix } from "@/lib/views/health/summary/fix-links";

/**
 * What each fix on Self-corrections does when pressed, as on the Summary: a
 * description update opens Quality › Descriptions (on Quality's rewrite of
 * the tool when Fixes holds one, else on the tool); any other fix opens on
 * Fixes, on the fix itself when Fixes has it, else on the list narrowed to
 * its tool, task or intent. Pure.
 */

export interface FixAction {
  kind: "description" | "fix";
  href: string;
  /** Fixes' own short title, when Fixes has the fix. */
  title: string | null;
}

export function fixActions(
  projectId: string,
  fixes: readonly FixView[],
  lookups: readonly FixLookup[] | null,
): Record<string, FixAction> {
  return Object.fromEntries(fixes.map((fix) => [fix.id, fixAction(projectId, fix, lookups)]));
}

export function fixAction(
  projectId: string,
  fix: FixView,
  lookups: readonly FixLookup[] | null,
): FixAction {
  const found = lookups ? findFix(lookups, `issue:${fix.id}`) : null;
  const title = found?.title ?? null;
  if (fix.descriptionTool || isDescriptionFix(found?.kind)) {
    const ref = found ?? {
      id: `issue:${fix.id}`,
      status: "open" as const,
      kind: "rewrite" as const,
      toolIds: fix.descriptionTool ? [fix.descriptionTool] : [],
    };
    const href = descriptionFixHref(projectId, ref, lookups ?? [], fix.descriptionTool);
    if (href) return { kind: "description", href, title };
  }
  return {
    kind: "fix",
    href: found ? fixHref(projectId, { peek: found.id }) : fix.fixesHref,
    title,
  };
}
