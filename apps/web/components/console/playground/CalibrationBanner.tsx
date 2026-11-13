"use client";

import { Flag, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { RecordedArm } from "@/lib/synthesis/playground/calibration-compare";
import {
  reproducesShadow,
  reproductionVerdict,
} from "@/lib/synthesis/playground/calibration-compare";
import type { RankedBuckets } from "@/lib/synthesis/playground/types";

export interface SelectionContext {
  selectionId: string;
  experimentName: string | null;
  /** The query the arms were recorded for. The comparison is only valid for it. */
  query: string;
  arms: RecordedArm[];
  exactOrder: boolean | null;
}

/** Why this page is showing extra columns, in one line. */
export function CalibrationBanner({
  context,
  saved,
  backHref,
}: {
  context: SelectionContext;
  saved: RankedBuckets;
  backHref: string | null;
}) {
  const reproduction = reproducesShadow(context.arms, saved);
  const verdict = reproduction ? reproductionVerdict(reproduction) : null;
  const agreed = context.exactOrder === true;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-forest-300/60 bg-base-deep/20 px-4 py-2.5">
      <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.09em] text-indigo-300">
        <Flag className="size-3" aria-hidden />
        {agreed ? "Recorded comparison" : "Recorded mismatch"}
      </span>
      <p className="min-w-0 flex-1 truncate text-xs text-cream" title={context.query}>
        {context.query}
      </p>

      {verdict && !verdict.ok && (
        <span
          title={verdict.detail}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-ctx-tools/30 px-1.5 py-0.5 text-[10px] text-ctx-tools"
        >
          <TriangleAlert className="size-2.5" aria-hidden />
          {verdict.label}
        </span>
      )}

      {backHref && (
        <Link
          href={backHref}
          title={`Open ${context.selectionId} in Calibration`}
          className="shrink-0 font-mono text-[10px] text-warm-muted transition-colors hover:text-cream"
        >
          Calibration →
        </Link>
      )}
    </div>
  );
}

/** Recorded results that are not in the catalog any more. */
export function UnresolvedNotice({ ids }: { ids: readonly string[] }) {
  if (ids.length === 0) return null;
  return (
    <p className="rounded-lg border border-dashed border-forest-300 px-3 py-2 text-[11px] leading-relaxed text-warm-muted">
      Recorded but no longer in your catalog:{" "}
      <span className="font-mono text-cream-dim">{ids.join(", ")}</span>
    </p>
  );
}
