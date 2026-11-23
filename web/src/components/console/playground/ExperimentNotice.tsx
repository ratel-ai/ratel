"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { ToolPin } from "@ratel/design-system/entity";
import { Callout } from "@ratel/design-system/states";
import Link from "next/link";
import {
  type KindById,
  type RecordedArm,
  reproducesShadow,
  reproductionVerdict,
  unresolvedIds,
} from "@/lib/synthesis/playground/calibration-compare";
import type { RankedBuckets } from "@/lib/synthesis/playground/types";

export interface SelectionContext {
  selectionId: string;
  experimentName: string | null;
  /** The ask the variants were recorded for. The comparison is only valid for it. */
  query: string;
  arms: RecordedArm[];
  exactOrder: boolean | null;
}

/**
 * Arriving from an experiment: one line on where this search came from, and
 * only the news worth reading (the catalog drifted since, or a recorded tool is
 * gone). The variants themselves are columns in Compare, beside today.
 */
export function ExperimentNotice({
  context,
  saved,
  kindById,
  backHref,
}: {
  context: SelectionContext;
  saved: RankedBuckets | null;
  kindById: KindById;
  backHref: string | null;
}) {
  const reproduction = saved ? reproducesShadow(context.arms, saved) : null;
  const drift = reproduction ? reproductionVerdict(reproduction) : null;
  const gone = unresolvedIds(context.arms, kindById);
  return (
    <Callout
      title={
        context.exactOrder === true
          ? "From an experiment"
          : "The experiment's variants disagreed on this ask"
      }
      action={
        backHref ? (
          <Link href={backHref} className={buttonVariants({ variant: "secondary", size: "sm" })}>
            Open the experiment
          </Link>
        ) : null
      }
    >
      {drift && !drift.ok ? <p>{drift.detail}</p> : null}
      {gone.length > 0 ? (
        <p className="mt-1 flex flex-wrap items-center gap-1.5">
          No longer in your catalog:
          {gone.map((id) => (
            <ToolPin key={id} name={id} missing />
          ))}
        </p>
      ) : null}
    </Callout>
  );
}
