import type { SkillFull } from "@/lib/catalog/agent-tools/outputs";
import type { MutationResult } from "./client";

/**
 * Pure logic behind the Explore skills multi-select: selection-set algebra for
 * the record table's checkbox column, and the plan/run/summarize cycle behind
 * the bulk publish/archive toolbar in `SkillsBrowser`.
 *
 * Selection is a Set of skill IDS only — never versions. Versions are resolved
 * by `planBulk` from the CURRENT props at action time, so a `router.refresh()`
 * between selecting and running can never submit a stale CAS token. Bulk runs
 * loop the existing single-skill routes sequentially (`runBulkAction`); there is
 * deliberately no bulk endpoint.
 */

export type BulkAction = "publish" | "archive";

/** One CAS'd request to make: version/name captured at plan time (= latest render). */
export interface BulkTarget {
  id: string;
  name: string;
  version: number;
}

export interface BulkFailure {
  id: string;
  name: string;
  status: number;
  reason?: string;
}

/** What a finished run looks like to the summary banner. `skipped` counts the
 * selected-but-already-there rows the plan never attempted. */
export interface BulkOutcome {
  action: BulkAction;
  succeeded: number;
  failures: BulkFailure[];
  skipped: number;
}

/* — selection-set algebra ————————————————————————————————————————————————————— */

export function toggleOne(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Header-checkbox behavior over the VISIBLE (filtered) row ids only: if every
 * visible row is selected, deselect them; otherwise select the union. Rows the
 * filter is hiding keep their selection either way — select-all never reaches
 * what the user can't see. */
export function toggleAll(selected: ReadonlySet<string>, visibleIds: string[]): Set<string> {
  const next = new Set(selected);
  if (selectAllState(selected, visibleIds) === "all") {
    for (const id of visibleIds) next.delete(id);
  } else {
    for (const id of visibleIds) next.add(id);
  }
  return next;
}

export type SelectAllState = "none" | "some" | "all";

export function selectAllState(
  selected: ReadonlySet<string>,
  visibleIds: string[],
): SelectAllState {
  const hits = visibleIds.filter((id) => selected.has(id)).length;
  if (hits === 0) return "none";
  return hits === visibleIds.length ? "all" : "some";
}

/** Drop selected ids that no longer exist in the refreshed skills prop. Skills
 * can't be deleted today (archive is terminal-ish), so this is a safety net for
 * cross-session drift, not a hot path. */
export function pruneSelection(
  selected: ReadonlySet<string>,
  skills: ReadonlyArray<Pick<SkillFull, "id">>,
): Set<string> {
  const alive = new Set(skills.map((s) => s.id));
  return new Set([...selected].filter((id) => alive.has(id)));
}

/** Stable, order-independent key for a selection set. Lets a UI detect that the
 * underlying selection changed since an action (e.g. the bulk-archive confirm
 * step) was armed against it — armed-then-selection-changed must re-confirm. */
export function selectionKey(selected: ReadonlySet<string>): string {
  return [...selected].sort().join("�");
}

/* — plan / run / summarize ———————————————————————————————————————————————————— */

function eligible(s: Pick<SkillFull, "status">, action: BulkAction): boolean {
  // Mirrors the single-row buttons: anything non-published can be published
  // (archived skills are re-publishable), anything non-archived can be archived.
  return action === "publish" ? s.status !== "published" : s.status !== "archived";
}

/** Resolve the selection against the current skills into concrete CAS targets,
 * in the skills' (server) order. Selected rows already in the desired state are
 * counted as `skipped`, not errors. */
export function planBulk(
  skills: SkillFull[],
  selected: ReadonlySet<string>,
  action: BulkAction,
): { targets: BulkTarget[]; skipped: number } {
  const targets: BulkTarget[] = [];
  let skipped = 0;
  for (const s of skills) {
    if (!selected.has(s.id)) continue;
    if (eligible(s, action)) targets.push({ id: s.id, name: s.name, version: s.version });
    else skipped++;
  }
  return { targets, skipped };
}

/** Run the targets strictly one at a time — parallel CAS'd writes against the
 * same catalog invite avoidable conflicts and hammer the route. Failures are
 * collected, never thrown; `onProgress(done)` fires after each settle. */
export async function runBulkAction(
  targets: BulkTarget[],
  send: (target: BulkTarget) => Promise<MutationResult<unknown>>,
  onProgress?: (done: number) => void,
): Promise<{ succeeded: number; failures: BulkFailure[] }> {
  let succeeded = 0;
  const failures: BulkFailure[] = [];
  for (const [i, t] of targets.entries()) {
    const r = await send(t);
    if (r.ok) succeeded++;
    else failures.push({ id: t.id, name: t.name, status: r.status, reason: r.reason });
    onProgress?.(i + 1);
  }
  return { succeeded, failures };
}

/** The banner's one-line verdict. */
export function summarizeBulk(o: BulkOutcome): string {
  const attempted = o.succeeded + o.failures.length;
  const done = o.action === "publish" ? "published" : "archived";
  if (attempted === 0) {
    // skipped === 0 too means the selection resolved to nothing at all (e.g. a
    // retry after the failed rows dropped out of the catalog) — not "already done".
    return o.skipped > 0
      ? `Nothing to ${o.action} — ${o.skipped} already ${done}.`
      : `Nothing to ${o.action}.`;
  }
  const verb = o.action === "publish" ? "Published" : "Archived";
  const parts = [`${verb} ${o.succeeded} of ${attempted} skill${attempted === 1 ? "" : "s"}`];
  if (o.failures.length > 0) parts.push(`${o.failures.length} failed`);
  if (o.skipped > 0) parts.push(`${o.skipped} already ${done}`);
  return `${parts.join(" · ")}.`;
}

/** Short per-row clause for the failure list (the full-sentence catalog in
 * `explainMutationError` is written for solo banners, not list items). */
export function bulkFailureLabel(status: number, reason?: string): string {
  switch (reason) {
    case "version_conflict":
      return "changed since you selected it — retry uses the latest version";
    case "not_found":
      return "no longer exists";
  }
  if (status === 401) return "session expired — sign in again";
  // The route's 404 body carries no `reason` (see mutationErrorResponse in
  // lib/catalog/http.ts) — status is the only signal we get for this case.
  if (status === 404) return "no longer exists";
  if (status === 0) return "network error";
  return "failed unexpectedly";
}
