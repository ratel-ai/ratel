import { CRAFT_FIX_KIND, FIX_KIND_LABELS, type FixKind } from "@/lib/views/fixes/kinds";
import { fixesForSubject } from "@/lib/views/fixes/select";
import type { TaskFixLike } from "@/lib/views/tasks/issues";
import type { TaskFixSource } from "@/lib/views/tasks/model";
import { descriptionsHref, fixesHref } from "@/lib/views/tasks/paths";

/**
 * The fixes a task's page lists and its row counts: Fixes' one model picked
 * with Fixes' own rule (`fixesForSubject`, the `?task=` filter), so a task
 * says the same number its link lands on. A description fix opens on Quality ›
 * Descriptions, the one place a description is updated. When Fixes could not
 * be read, the drafted changes on the task's tools stand in. Pure.
 */

export interface FixView {
  /** The id Fixes opens it by (`?peek=`). */
  id: string;
  kind: FixKind;
  kindLabel: string;
  /** Verb first, plain. */
  title: string;
  tools: { id: string; label: string }[];
  href: string;
}

/**
 * Where a fix opens: a description update on Quality › Descriptions (on
 * Quality's drafted rewrite when there is one, else on the tool), any other
 * fix on Fixes.
 */
export function fixHref(
  projectId: string,
  fix: Pick<TaskFixLike, "id" | "kind" | "source" | "subject">,
): string {
  if (fix.kind === "rewrite") {
    if (fix.source === "rewrite") return descriptionsHref(projectId, { peek: fix.id });
    const tool = fix.subject.tools[0]?.id;
    if (tool) return descriptionsHref(projectId, { tool });
  }
  return fixesHref(projectId, { peek: fix.id });
}

/** Fixes the list counts for a task: Fixes' own when read, else the drafts on its tools. */
export function taskFixCount(
  taskId: string,
  fixes: readonly TaskFixLike[] | null | undefined,
  drafts: readonly TaskFixSource[],
): number {
  return fixes ? fixesForSubject(fixes, { task: taskId }).length : drafts.length;
}

export function taskFixViews(input: {
  projectId: string;
  taskId: string;
  fixes: readonly TaskFixLike[] | null | undefined;
  drafts: readonly TaskFixSource[];
  names: ReadonlyMap<string, string>;
}): FixView[] {
  const { projectId, fixes, names } = input;
  if (fixes) {
    return fixesForSubject(fixes, { task: input.taskId }).map((fix) => ({
      id: fix.id,
      kind: fix.kind,
      kindLabel: fix.kindLabel,
      title: fix.title,
      tools: fix.subject.tools.map((tool) => ({ id: tool.id, label: tool.label })),
      href: fixHref(projectId, fix),
    }));
  }
  return input.drafts.map((draft) => {
    const kind = CRAFT_FIX_KIND[draft.kind] ?? "build";
    return {
      id: `craft:${draft.id}`,
      kind,
      kindLabel: FIX_KIND_LABELS[kind],
      title: draft.headline,
      tools: draft.toolIds.map((id) => ({ id, label: names.get(id) ?? id })),
      href: fixesHref(projectId, { peek: `craft:${draft.id}` }),
    };
  });
}
