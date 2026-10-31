import type { FixFilters } from "@/lib/views/fixes/href";
import type { FixKind } from "@/lib/views/fixes/kinds";
import type { Fix, FixStats } from "@/lib/views/fixes/types";

/**
 * Reading a list of fixes: find one by any of its ids, filter by the URL's
 * filters, pick the ones about a subject, order them and count them. Pure and
 * client-safe, so Fixes filters in the browser and other pages pick the
 * fixes that are theirs with the same rules.
 */

/** The fix an id opens: its own id, a draft merged into it, or an issue it resolves. */
export function findFix<T extends Pick<Fix, "id" | "aliases">>(
  fixes: readonly T[],
  id: string | null | undefined,
): T | null {
  if (!id) return null;
  return (
    fixes.find((fix) => fix.id === id) ?? fixes.find((fix) => fix.aliases.includes(id)) ?? null
  );
}

export interface FixSubjectQuery {
  kind?: FixKind | null;
  task?: string | null;
  tool?: string | null;
  topic?: string | null;
  /** An issue id (`trace_signals.id`). */
  issue?: string | null;
}

/**
 * The fixes about a subject: every key given must match. For a task's page
 * (`{ task }`), a tool (`{ tool }`), a topic (`{ topic }`) or an issue
 * (`{ issue }`, the fixes that resolve it).
 */
export function fixesForSubject<T extends Pick<Fix, "kind" | "subject" | "issues">>(
  fixes: readonly T[],
  query: FixSubjectQuery,
): T[] {
  return fixes.filter(
    (fix) =>
      (!query.kind || fix.kind === query.kind) &&
      (!query.task || fix.subject.tasks.some((task) => task.id === query.task)) &&
      (!query.tool || fix.subject.tools.some((tool) => tool.id === query.tool)) &&
      (!query.topic || fix.subject.topics.some((topic) => topic.id === query.topic)) &&
      (!query.issue || fix.issues.some((issue) => issue.id === query.issue)),
  );
}

/** The URL's filters over a list. */
export function filterFixes<T extends Pick<Fix, "kind" | "subject" | "issues">>(
  fixes: readonly T[],
  filters: FixFilters,
): T[] {
  return fixesForSubject(fixes, filters);
}

/** Biggest effect first: lower tier, then the tier's own measure, then a stable tie-break. */
export function compareFixes(
  a: Pick<Fix, "rank" | "kind" | "title">,
  b: Pick<Fix, "rank" | "kind" | "title">,
  kindOrder: readonly string[],
): number {
  return (
    a.rank.tier - b.rank.tier ||
    b.rank.score - a.rank.score ||
    b.rank.count - a.rank.count ||
    kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) ||
    (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)
  );
}

/**
 * The numbers over the open fixes. Round trips are summed only where it is
 * honest: fixes that touch a common tool can save the same round trip, so
 * each group of overlapping fixes counts its biggest saving once.
 */
export function fixStats(open: readonly Fix[]): FixStats {
  const issues = new Set(open.flatMap((fix) => fix.issues.map((issue) => issue.id)));
  const tools = new Set(open.flatMap((fix) => fix.subject.tools.map((tool) => tool.id)));
  const evidence: FixStats["evidence"] = { strong: 0, solid: 0, early: 0, none: 0 };
  for (const fix of open) evidence[fix.evidence?.strength ?? "none"] += 1;
  return {
    open: open.length,
    ready: open.filter((fix) => fix.actions.apply).length,
    fromIssues: open.filter((fix) => fix.issues.length > 0).length,
    issues: issues.size,
    tools: tools.size,
    roundTripsSaved: roundTripsSaved(open),
    evidence,
  };
}

function roundTripsSaved(open: readonly Fix[]): number | null {
  const saving = open.filter((fix) => (fix.gain?.roundTrips ?? 0) > 0);
  if (saving.length === 0) return null;
  // Union-find over shared tools: one group per set of fixes that overlap.
  const parent = saving.map((_, index) => index);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)));
  const owner = new Map<string, number>();
  saving.forEach((fix, index) => {
    for (const tool of fix.subject.tools) {
      const seen = owner.get(tool.id);
      if (seen === undefined) owner.set(tool.id, index);
      else parent[root(index)] = root(seen);
    }
  });
  const best = new Map<number, number>();
  saving.forEach((fix, index) => {
    const group = root(index);
    best.set(group, Math.max(best.get(group) ?? 0, fix.gain!.roundTrips));
  });
  return [...best.values()].reduce((sum, value) => sum + value, 0);
}
