import type { SortDirection } from "@ratel/design-system/table-model";
import type { SkillItem, SkillStatus } from "./items";

/**
 * Search, status filter and sort for the v2 Skills table, read from the URL
 * (`q`, `status`, `sort`, `dir`). Cloud, runtime and observed skills share one
 * table here, so the v1 helpers (which only know Cloud skills) do not fit.
 */

export type SkillsSortKey = "name" | "runs" | "updated";
export type SkillsStatusFilter = SkillStatus | "all";

export interface SkillsView {
  query: string;
  status: SkillsStatusFilter;
  sort: SkillsSortKey;
  direction: SortDirection;
}

/** Newest first, the order the v1 table and `listSkills` open in. */
export const DEFAULT_SKILLS_VIEW: SkillsView = {
  query: "",
  status: "all",
  sort: "updated",
  direction: "desc",
};

const SORT_KEYS: readonly SkillsSortKey[] = ["name", "runs", "updated"];
const STATUSES: readonly SkillsStatusFilter[] = ["all", "published", "draft", "archived"];

export function resolveSkillsView(params: { get(name: string): string | null }): SkillsView {
  const sort = params.get("sort");
  const status = params.get("status");
  const dir = params.get("dir");
  return {
    query: params.get("q") ?? "",
    status: STATUSES.includes(status as SkillsStatusFilter)
      ? (status as SkillsStatusFilter)
      : "all",
    sort: SORT_KEYS.includes(sort as SkillsSortKey)
      ? (sort as SkillsSortKey)
      : DEFAULT_SKILLS_VIEW.sort,
    direction: dir === "asc" || dir === "desc" ? dir : DEFAULT_SKILLS_VIEW.direction,
  };
}

/**
 * Name and description match plus the status facet. A status only exists on
 * Cloud skills, so filtering by one leaves runtime and observed skills out.
 */
/**
 * Whether an item matches the search box: its name, the searchable
 * description (the text matching reads, shown in the tables) and the agent
 * description, so a just-saved searchable text is findable at once.
 */
export function itemMatchesQuery(
  item: Pick<SkillItem, "name" | "agentDescription"> & { searchable: { text: string } | null },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [item.name, item.searchable?.text, item.agentDescription].some((text) =>
    text?.toLowerCase().includes(needle),
  );
}

export function filterSkillItems(
  items: readonly SkillItem[],
  view: Pick<SkillsView, "query" | "status">,
): SkillItem[] {
  const needle = view.query.trim().toLowerCase();
  return items.filter((item) => {
    if (view.status !== "all" && item.status !== view.status) return false;
    return needle === "" || itemMatchesQuery(item, needle);
  });
}

/** When a skill last changed: its last edit, or, for one Cloud does not own, when it was last seen. */
export function skillUpdatedAt(item: SkillItem): string | null {
  return item.updatedAt ?? item.lastSeenAt;
}

/** A sorted copy. Missing dates sort last in both directions; ties fall back to the name. */
export function sortSkillItems(
  items: readonly SkillItem[],
  sort: SkillsSortKey,
  direction: SortDirection,
): SkillItem[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    if (sort === "updated") {
      const left = skillUpdatedAt(a);
      const right = skillUpdatedAt(b);
      if (left === null || right === null) {
        if (left !== right) return left === null ? 1 : -1;
      } else if (left !== right) {
        return (left < right ? -1 : 1) * sign;
      }
    } else if (sort === "runs" && a.runs !== b.runs) {
      return (a.runs - b.runs) * sign;
    } else if (sort === "name") {
      return a.name.localeCompare(b.name) * sign;
    }
    return a.name.localeCompare(b.name);
  });
}
