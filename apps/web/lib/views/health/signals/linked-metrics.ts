import {
  type DayBucket,
  readTile,
  TILE_META,
  type TileMeta,
  type TileReading,
  type TileWindow,
  tilesWith,
} from "@/lib/readings/trace-signals/signals/project-metrics";
import type { HealthTile } from "@/lib/readings/trace-signals/view";

/**
 * The band of a project that sends the Ratel SDK and OpenTelemetry for the
 * same agent: SDK runs linked to their model calls add a day's cost and model
 * calls (`DayBucket.linked`, `linked-day.ts`), and the band swaps two of the
 * four search tiles (detours, junk in lists) for "Cost per run" and "Model
 * calls per run". Every other project's band is exactly as it was.
 */

const fmt = (n: number): string => n.toLocaleString("en-US");

const COST: TileMeta = { key: "cost_per_run", label: "Cost per run", unit: "usd", upIsGood: false };
const MODEL_CALLS: TileMeta = {
  key: "model_calls",
  label: "Model calls per run",
  unit: "per_turn",
  upIsGood: false,
};
const KEPT = new Set<HealthTile["key"]>(["first_try", "wasted_calls"]);

function readLinkedTile(key: HealthTile["key"], bucket: DayBucket): TileReading {
  const linked = bucket.linked;
  if (key === "cost_per_run") {
    const priced = linked?.pricedRuns ?? 0;
    return {
      value: priced > 0 ? linked!.costUsd / priced : null,
      interval: null,
      n: priced,
      sub:
        priced > 0
          ? `Model cost of ${fmt(priced)} runs, from the model calls OpenTelemetry sent.`
          : "The model's price is not known yet.",
    };
  }
  if (key === "model_calls") {
    const runs = linked?.runs ?? 0;
    return {
      value: runs > 0 ? linked!.modelCalls / runs : null,
      interval: null,
      n: runs,
      sub: `${fmt(linked?.modelCalls ?? 0)} model calls over ${fmt(runs)} runs.`,
    };
  }
  return readTile(key, bucket);
}

/** Whether the window has SDK runs linked to model calls. */
export function hasLinkedRuns(total: Pick<DayBucket, "linked">): boolean {
  return (total.linked?.runs ?? 0) > 0;
}

/** First try and wasted calls, then cost and model calls per run, over a window. */
export function linkedTilesFor(buckets: readonly DayBucket[], w: TileWindow): HealthTile[] {
  const metas = [...TILE_META.filter((meta) => KEPT.has(meta.key)), COST, MODEL_CALLS];
  return tilesWith(buckets, w, metas, readLinkedTile);
}
