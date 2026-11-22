import { DEFAULT_REPLAY_WINDOW, REPLAY_TOP_K } from "@/lib/synthesis/match-quality/replay";
import {
  changesRanking,
  type FixChange,
  type InvokeStep,
  type RunRecord,
  type RunView,
  type SearchStep,
  type SkipReason,
} from "./types";

/**
 * The sandboxed evaluator: one stored run, replayed with the fix applied.
 * Pure and deterministic. It never calls a tool, a model or the network; it
 * reads the run's recorded steps and, for ranking changes, ranks the run's own
 * ask again with the SDK's BM25 (`Ranker`, the same engine Quality's replay
 * uses), on the catalog as it is and as the fix leaves it.
 *
 * Ranking changes are paired: both sides are ranked by the same engine, so its
 * bias against production cancels in the difference (the reasoning in
 * `lib/match-quality/replay.ts`). Changes to what the model does (retries,
 * merged tools, skills) are not simulated here any more (RC-61): editing the
 * recorded calls only checked what the edit guaranteed. They are replayed by a
 * model (`replay.ts`) or reported as "can't simulate".
 */

/** Ranks one ask against a catalog: ids, best first, at most `depth`. */
export interface Ranker {
  before(query: string, depth: number): string[];
  after(query: string, depth: number): string[];
}

export interface SimulatedRun {
  before: RunView;
  after: RunView;
  /** Set when the run can't be simulated; the checks are not read then. */
  skipped: SkipReason | null;
  /** True when the first list was ranked again from the ask's text (else read from the recording). */
  reranked: boolean;
}

/** The window the agent saw for one search: the served list's length, capped by its top-k. */
export function windowOf(step: Pick<SearchStep, "hitIds" | "topK">): number {
  const served = step.hitIds && step.hitIds.length > 0 ? step.hitIds.length : DEFAULT_REPLAY_WINDOW;
  const capped = step.topK && step.topK > 0 ? Math.min(served, step.topK) : served;
  return Math.max(1, Math.min(capped, REPLAY_TOP_K));
}

function searches(run: RunRecord): SearchStep[] {
  return run.steps.filter((step): step is SearchStep => step.kind === "search");
}

/** The run's tool searches: a skill lookup ranks skills, so it never stands for the list a tool was found in. */
function toolSearches(run: RunRecord): SearchStep[] {
  return searches(run).filter((step) => step.searchType !== "skill_search");
}

/**
 * The search the right-tool check reads (RC-77): the last tool search before
 * the run first called `tool`, the search it was found with or should have
 * been, as the fix's own metric scores a search against the tool invoked from
 * it; else the run's first tool search. Reading the run's first search instead
 * scored a hotel run's skill lookup ("weekend trip planner") for
 * `search_hotels`, which is never in that list.
 */
export function searchFor(run: RunRecord, tool: string | null = null): SearchStep | undefined {
  const tools = toolSearches(run);
  if (tool) {
    const call = invokes(run).find((step) => step.targetId === tool);
    const before = call ? tools.filter((step) => step.ordinal < call.ordinal) : [];
    if (before.length > 0) return before[before.length - 1];
  }
  return tools[0];
}

function invokes(run: RunRecord): InvokeStep[] {
  return run.steps.filter((step): step is InvokeStep => step.kind === "invoke");
}

/** The run as recorded: everything is known, cost and time when they were recorded. The list is the one `tool` was looked for in (`searchFor`). */
export function recordedView(run: RunRecord, tool: string | null = null): RunView {
  const first = searchFor(run, tool);
  const calls = invokes(run);
  return {
    firstList: first?.hitIds ? first.hitIds.slice(0, windowOf(first)) : null,
    searches: searches(run).length,
    calls: calls.map((call) => call.targetId),
    outcomes: calls.map((call) => call.outcome),
    failed: calls.filter((call) => call.outcome === "error").length,
    answered: run.answered ?? null,
    costUsd: run.costUsd ?? null,
    latencyMs: run.durationMs ?? null,
  };
}

/** A tool id as the changed catalog knows it: a source of an added tool becomes that tool. */
export function mapTool(id: string, change: FixChange): string {
  const added = change.add.find((tool) => tool.replaces.includes(id));
  return added ? added.id : id;
}

/** A recorded list with the change's hides, stand-ins and cut applied. */
function transformList(list: readonly string[], change: FixChange, window: number): string[] {
  const out: string[] = [];
  for (const id of list) {
    const mapped = mapTool(id, change);
    if (change.hide.includes(id) && mapped === id) continue;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out.slice(0, change.topK !== null ? Math.min(window, change.topK) : window);
}

/** Whether the change touches anything this run did or saw. */
export function affects(run: RunRecord, change: FixChange): boolean {
  if (change.topK !== null) return searches(run).length > 0;
  const touched = new Set([
    ...Object.keys(change.patches),
    ...change.hide,
    ...change.add.flatMap((tool) => tool.replaces),
    ...change.collapse,
    ...change.dedupeRetries,
    ...change.skillSteps,
  ]);
  for (const step of run.steps) {
    if (step.kind === "invoke" && touched.has(step.targetId)) return true;
    if (step.kind === "search" && step.hitIds?.some((id) => touched.has(id))) return true;
  }
  // A rewrite can bring a tool into a list it never reached: any readable search counts.
  return Object.keys(change.patches).length > 0 || change.add.length > 0
    ? toolSearches(run).some((step) => step.query)
    : false;
}

/**
 * The re-rank (RC-61: the only deterministic method). The after side knows
 * its first list and nothing else: what the agent would have called with
 * that list is not something a recorded run can say, so calls, searches,
 * failures, cost and time are unknown there and those checks aren't scored.
 * `tool` is the run's expected tool: the list both sides read is the one it
 * was looked for in (`searchFor`).
 */
export function simulateRun(
  run: RunRecord,
  change: FixChange,
  ranker: Ranker | null,
  tool: string | null = null,
): SimulatedRun {
  const recorded = recordedView(run, tool);
  const first = searchFor(run, tool);
  const after: RunView = {
    firstList: recorded.firstList,
    searches: null,
    calls: null,
    outcomes: null,
    failed: null,
    answered: null,
    costUsd: null,
    latencyMs: null,
  };
  let before = recorded;
  let reranked = false;

  if (first) {
    const window = windowOf(first);
    // Only new text needs the ask: a stand-in or a hidden tool can be read off the recorded list.
    const needsText = Object.keys(change.patches).length > 0;
    if (changesRanking(change) && ranker && first.query) {
      // Paired: the same engine on both sides, each cut to the window the agent saw.
      before = { ...recorded, firstList: ranker.before(first.query, window) };
      after.firstList = transformList(ranker.after(first.query, REPLAY_TOP_K), change, window);
      reranked = true;
    } else if (needsText) {
      // A rewrite moves lists only through the ask's text; without it there is nothing to rank.
      return {
        before: recorded,
        after,
        skipped: first.query ? "not-affected" : "query-expired",
        reranked,
      };
    } else if (first.hitIds) {
      after.firstList = transformList(first.hitIds, change, window);
    }
  }
  return { before, after, skipped: null, reranked };
}
