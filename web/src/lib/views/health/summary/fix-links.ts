import type { FixKind } from "@/lib/views/fixes/kinds";
import type { FixSource } from "@/lib/views/fixes/types";

/**
 * Where a fix is made. A description update (a rewrite, or telling two
 * tools apart in their descriptions) is made on Quality › Descriptions, the
 * description-update page: on Quality's own rewrite of the tool when Fixes
 * has one, else on the tool. Every other fix opens on Fixes. Pure and
 * client-safe, so the Summary and Self-corrections build the same links.
 */

/**
 * The kinds of fix that change searchable descriptions: rewriting one, and
 * telling two tools apart in theirs. Both are made on Quality › Descriptions,
 * on the first tool the fix names.
 */
export const DESCRIPTION_FIX_KINDS: ReadonlySet<FixKind> = new Set<FixKind>([
  "rewrite",
  "tell-apart",
]);

/** The button a description fix wears, everywhere it is offered. */
export const DESCRIPTION_FIX_LABEL = "Update description";

export function isDescriptionFix(kind: FixKind | null | undefined): boolean {
  return kind ? DESCRIPTION_FIX_KINDS.has(kind) : false;
}

/** Quality › Descriptions, opened on one tool (`?tool=`) or on one of Quality's rewrites (`?peek=rewrite:<id>`). */
export function descriptionsHref(
  projectId: string,
  target: { tool: string } | { rewrite: string },
): string {
  const params = new URLSearchParams(
    "rewrite" in target ? { peek: target.rewrite } : { tool: target.tool },
  );
  return `/project/${encodeURIComponent(projectId)}/quality/descriptions?${params.toString()}`;
}

/** A fix as these links read it. */
export interface FixRef {
  /** `rewrite:<proposal id>` for Quality's rewrites. */
  id: string;
  kind?: FixKind;
  source?: FixSource;
  status: "open" | "applied";
  /** The catalog tools it changes. */
  toolIds?: readonly string[];
}

/** Quality's rewrite of a tool, when Fixes holds one: an open one before an applied one. */
export function rewriteOfTool<T extends FixRef>(fixes: readonly T[], toolId: string): T | null {
  const rewrites = fixes.filter(
    (fix) => fix.source === "rewrite" && (fix.toolIds ?? []).includes(toolId),
  );
  return rewrites.find((fix) => fix.status === "open") ?? rewrites[0] ?? null;
}

/**
 * Where a description fix is made: Quality's rewrite of its tool when one
 * exists, else its tool on Descriptions. `fallbackTool` names the tool when
 * the fix itself names none (an issue's own fix). Null without any tool.
 */
export function descriptionFixHref(
  projectId: string,
  fix: FixRef,
  fixes: readonly FixRef[],
  fallbackTool: string | null,
): string | null {
  const tool = fix.toolIds?.[0] ?? fallbackTool;
  const rewrite = fix.source === "rewrite" ? fix : tool ? rewriteOfTool(fixes, tool) : null;
  if (rewrite) return descriptionsHref(projectId, { rewrite: rewrite.id });
  return tool ? descriptionsHref(projectId, { tool }) : null;
}
