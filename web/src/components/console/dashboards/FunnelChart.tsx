"use client";

import { cn } from "@ratel/design-system/cn";
import Link from "next/link";
import type { FunnelResult, FunnelStepResult } from "@/lib/synthesis/metrics/funnel";
import { formatInteger, formatPercent } from "@/lib/synthesis/traces/v2/format";
import { SampleNote } from "./SampleNote";

/**
 * A funnel as one bar per step, as wide as its share of the first one. A step whose traces the
 * Traces filter can name opens them.
 */
export function FunnelChart({
  result,
  label,
  stepHref,
  fill = false,
}: {
  result: FunnelResult;
  label: string;
  /** Null when the Traces filter cannot say which traces reached the step. */
  stepHref: (index: number) => string | null;
  /** Take the height of the place it is in. */
  fill?: boolean;
}) {
  const first = result.steps[0]?.count ?? 0;
  return (
    <div className={cn("flex min-w-0 flex-col", fill && "h-full")}>
      <ol aria-label={label} className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
        {result.steps.map((step, index) => {
          const href = stepHref(index);
          const body = (
            <Step step={step} index={index} share={first > 0 ? step.count / first : 0} />
          );
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: a step is its position.
              key={index}
            >
              {href ? (
                <Link
                  href={href}
                  className="block rounded-md outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {body}
                </Link>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ol>
      <SampleNote sample={result.sample} />
    </div>
  );
}

function Step({
  step: { name, count, conversion },
  index,
  share,
}: {
  step: FunnelStepResult;
  index: number;
  share: number;
}) {
  return (
    <div className="flex flex-col gap-1 px-1 py-1.5">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate text-fg">
          <span className="text-fg-subtle tabular-nums">{index + 1}. </span>
          {name}
        </span>
        <span className="shrink-0 text-fg tabular-nums">{formatInteger(count)}</span>
        <span className="w-12 shrink-0 text-right text-fg-muted tabular-nums">
          {formatPercent(share)}
        </span>
      </div>
      <div aria-hidden className="h-3 overflow-hidden rounded-sm bg-raised">
        <div
          className="h-full rounded-sm bg-chart-1"
          style={{ width: `${share * 100}%`, minWidth: count > 0 ? 2 : 0 }}
        />
      </div>
      {conversion !== null ? (
        <p className="text-xs text-fg-subtle tabular-nums">
          {formatPercent(conversion)} of the step before
          {conversion < 1 ? `, ${formatPercent(1 - conversion)} dropped` : ""}
        </p>
      ) : null}
    </div>
  );
}
