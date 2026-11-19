import { RUN_BOUND_KINDS } from "@/lib/readings/trace-signals/run-bound";
import type {
  HealthPageModel,
  HealthTile,
  HealthTileKey,
  SignalView,
} from "@/lib/readings/trace-signals/view";

/**
 * What the page hides when the data cannot carry it. Two gaps reach past the
 * workflows: with no tool call recorded, or with runs from different users
 * mixed together, the run shapes, the workflows and the tool map are all read
 * from runs that do not mean anything, so one example with one message stands
 * in for the three. The band keeps the tiles that do not depend on where a run
 * starts and ends, and blanks the ones that do.
 */

export type PageGap = "no_tool_calls" | "mixed_runs";

/** The gap the whole run-based middle of the page is hidden for, or null. */
export function pageGap(model: Pick<HealthPageModel, "workflows">): PageGap | null {
  return model.workflows?.blocked ?? null;
}

/** Tiles read per run, so meaningless when runs are mixed; and those that need a tool call. */
const NEEDS_RUNS: ReadonlySet<HealthTileKey> = new Set<HealthTileKey>([
  "first_try",
  "detours",
  "wasted_calls",
]);
const NEEDS_TOOL_CALLS: ReadonlySet<HealthTileKey> = new Set<HealthTileKey>([
  "first_try",
  "wasted_calls",
]);

const GAP_SUB: Readonly<Record<PageGap, string>> = {
  no_tool_calls: "Needs tool calls, which are not sent yet.",
  mixed_runs: "Needs turn ids: calls from different users are mixed in one run.",
};

/** The band with the tiles a gap makes meaningless shown as a dash and why. */
export function tilesForGap(tiles: readonly HealthTile[], gap: PageGap | null): HealthTile[] {
  if (!gap) return [...tiles];
  const hidden = gap === "mixed_runs" ? NEEDS_RUNS : NEEDS_TOOL_CALLS;
  return tiles.map((tile) =>
    hidden.has(tile.key)
      ? { ...tile, value: null, interval: null, delta: null, series: [], sub: GAP_SUB[gap] }
      : tile,
  );
}

/** The problem list without what a mixed reading cannot see (kinds left open from before the mixing included). */
export function signalsForGap<T extends Pick<SignalView, "kind">>(
  signals: readonly T[],
  gap: PageGap | null,
): T[] {
  return gap === "mixed_runs"
    ? signals.filter((signal) => !RUN_BOUND_KINDS.has(signal.kind))
    : [...signals];
}
