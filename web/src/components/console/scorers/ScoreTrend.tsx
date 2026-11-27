"use client";

import { Tooltip } from "@ratel/design-system/tooltip";
import { formatDay, formatInteger, formatPercent } from "@/lib/synthesis/traces/v2/format";
import { formatAverage } from "@/lib/views/scorers/format";

export interface TrendDay {
  /** UTC, YYYY-MM-DD. */
  day: string;
  scored: number;
  /** The pass rate (0 to 1) or the average (1 to 5); null without a result. */
  value: number | null;
}

/** One bar per day, on one fixed scale, so two scorers of a kind compare by eye. */
export function ScoreTrend({ days, verdict }: { days: readonly TrendDay[]; verdict: boolean }) {
  const top = verdict ? 1 : 5;
  const label = (value: number) => (verdict ? formatPercent(value) : formatAverage(value));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-3">
        <div
          aria-hidden
          className="flex h-36 w-10 shrink-0 flex-col justify-between text-right text-xs text-fg-subtle tabular-nums"
        >
          <span>{label(top)}</span>
          <span>{label(top / 2)}</span>
          <span>{label(0)}</span>
        </div>
        <ul className="flex h-36 flex-1 items-end gap-0.5 border-line border-b">
          {days.map(({ day, value, scored }) => {
            const words =
              value === null
                ? `${formatDay(day)}: no results`
                : `${formatDay(day)}: ${label(value)}, ${formatInteger(scored)} scored`;
            return (
              <li key={day} className="h-full min-w-0 flex-1">
                <Tooltip content={words}>
                  <span className="flex h-full items-end justify-center rounded-sm hover:bg-hover">
                    {value === null ? null : (
                      <span
                        aria-hidden
                        className="block w-full max-w-8 rounded-t-[4px] bg-chart-1"
                        style={{ height: `max(2px, ${(value / top) * 100}%)` }}
                      />
                    )}
                    <span className="sr-only">{words}</span>
                  </span>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      </div>
      <div aria-hidden className="flex justify-between pl-13 text-xs text-fg-subtle tabular-nums">
        <span>{days[0] ? formatDay(days[0].day) : null}</span>
        <span>{days.length > 1 ? formatDay(days[days.length - 1]?.day ?? "") : null}</span>
      </div>
    </div>
  );
}
