import type { SkillFull } from "@/lib/catalog/agent-tools/outputs";
import type { SkillStatus } from "@/lib/catalog/manage";

/**
 * Pure sort/filter logic behind the Explore skills record table
 * (`components/explore/SkillRecordTable.tsx`). Kept out of the component so the
 * comparators are unit-testable under the repo's `tsx --test` harness — the full
 * `SkillFull` set is already in client memory, so all of this runs client-side
 * with no server round-trip per sort/filter change.
 */

export type SkillSortKey =
  | "name"
  | "status"
  | "version"
  | "model"
  | "scope"
  | "tags"
  | "tools"
  | "updatedAt";

export interface SkillSort {
  key: SkillSortKey;
  dir: "asc" | "desc";
}

/** Matches the server read's order (`listSkills` → updatedAt desc) so the first
 * paint is stable before anyone touches a header. */
export const DEFAULT_SKILL_SORT: SkillSort = { key: "updatedAt", dir: "desc" };

/** The record table's Scope cell: the end-user id, or "Global" for the norm. */
export function skillScope(s: Pick<SkillFull, "endUserId">): string {
  return s.endUserId ?? "Global";
}

/** Case-insensitive substring filter over name + description, then status. */
export function filterSkills(
  skills: SkillFull[],
  q: string,
  status: SkillStatus | "all",
): SkillFull[] {
  const needle = q.trim().toLowerCase();
  return skills.filter((s) => {
    if (status !== "all" && s.status !== status) return false;
    if (!needle) return true;
    return s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle);
  });
}

/** Per-key comparator, ascending. Nullable text (model) sorts nulls LAST in both
 * directions — "no value" is noise, not a superlative. ISO-8601 strings compare
 * correctly as plain strings. */
function compareAsc(a: SkillFull, b: SkillFull, key: SkillSortKey): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "status":
      return a.status.localeCompare(b.status);
    case "version":
      return a.version - b.version;
    case "model": {
      if (a.model === null && b.model === null) return 0;
      if (a.model === null) return 1; // nulls last regardless of direction
      if (b.model === null) return -1;
      return a.model.localeCompare(b.model);
    }
    case "scope":
      return skillScope(a).localeCompare(skillScope(b));
    case "tags":
      return a.tags.join(", ").localeCompare(b.tags.join(", "));
    case "tools":
      return a.tools.length - b.tools.length;
    case "updatedAt":
      return a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
  }
}

/** Stable sort (copy, never in place), tie-broken by name so equal keys render in
 * a deterministic order. The nulls-last rule survives `desc` by design. */
export function sortSkills(skills: SkillFull[], sort: SkillSort): SkillFull[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...skills].sort((a, b) => {
    if (sort.key === "model") {
      // Apply direction to the values, not the null placement.
      if (a.model === null && b.model === null) return a.name.localeCompare(b.name);
      if (a.model === null) return 1;
      if (b.model === null) return -1;
    }
    const cmp = compareAsc(a, b, sort.key);
    if (cmp !== 0) return cmp * sign;
    return a.name.localeCompare(b.name);
  });
}

/** Header-click behavior: same key flips direction; a new key starts ascending,
 * except `updatedAt` which starts at its natural "most recent first". */
export function toggleSort(current: SkillSort, key: SkillSortKey): SkillSort {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "updatedAt" ? "desc" : "asc" };
}
