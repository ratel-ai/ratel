import type { FixKind } from "@/lib/views/fixes/kinds";

/**
 * What a person does with a fix, which is how Fixes splits its tables:
 * update a searchable description (applied on Quality › Descriptions),
 * change their tools (a prompt for their coding agent), add a skill, or
 * change a ranking setting. Every kind belongs to exactly one group, so a
 * reader picks a table by what they are about to do, never by which engine
 * found the fix. Pure, client-safe.
 */

/** In table order. */
export const FIX_GROUPS = ["descriptions", "tools", "skills", "ranking"] as const;

export type FixGroup = (typeof FIX_GROUPS)[number];

export const FIX_KIND_GROUP: Readonly<Record<FixKind, FixGroup>> = {
  rewrite: "descriptions",
  "tell-apart": "descriptions",
  retire: "tools",
  merge: "tools",
  combine: "tools",
  build: "tools",
  "fail-clearly": "tools",
  schema: "tools",
  fold: "tools",
  parallel: "tools",
  enrich: "tools",
  preload: "tools",
  split: "tools",
  prerequisite: "tools",
  skill: "skills",
  "fewer-results": "ranking",
};

/** Each table's title: what you do there. */
export const FIX_GROUP_TITLES: Readonly<Record<FixGroup, string>> = {
  descriptions: "Update descriptions",
  tools: "Change your tools",
  skills: "Add skills",
  ranking: "Ranking settings",
};

/** The one line under each title. */
export const FIX_GROUP_LINES: Readonly<Record<FixGroup, string>> = {
  descriptions: "Words that get the right tool found. You apply them on Quality.",
  tools: "Changes in your tool server. Copy a prompt for your coding agent.",
  skills: "Steps your agent repeats, written down once as a skill.",
  ranking: "How many results each search returns.",
};

/** Each table's anchor on Fixes (`#fixes-tools`), so the numbers above can jump to it. */
export function groupAnchor(group: FixGroup): string {
  return `fixes-${group}`;
}

export function fixGroup(kind: FixKind): FixGroup {
  return FIX_KIND_GROUP[kind];
}

/** The fixes of each group, in their list order; groups in table order, empty ones left out. */
export function groupFixes<T extends { group: FixGroup }>(
  fixes: readonly T[],
): { group: FixGroup; fixes: T[] }[] {
  return FIX_GROUPS.map((group) => ({
    group,
    fixes: fixes.filter((fix) => fix.group === group),
  })).filter((entry) => entry.fixes.length > 0);
}
