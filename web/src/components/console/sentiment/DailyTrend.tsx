"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { ChartLine } from "lucide-react";
import { useId, useState } from "react";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import { percent, plural } from "@/components/console/sentiment/copy";
import { areaPath, gapSegments, labelEvery, smoothPath } from "@/lib/platform/chart";
import { dayStops, MOOD_STOPS, moodColor } from "@/lib/views/traces/sentiment/mood";
import { type DayPoint, SMOOTHING_DAYS } from "@/lib/views/traces/sentiment/overview";

const WIDTH = 800;
const HEIGHT = 180;
const LEFT = 4;
const PLOT_WIDTH = WIDTH - LEFT * 2;
const PLOT_BOTTOM = 156;
const PAD_TOP = 12;
/**
 * Satisfaction day by day over the window (UTC): each day's point is
 * satisfied of the turns people said how it went over that day and the
 * `SMOOTHING_DAYS` - 1 before it, so a day with one or two answers does not
 * swing the line. Days before the first answer leave a gap. The daily
 * numbers are one click away as a table.
 */
export function DailyTrend({ days }: { days: readonly DayPoint[] }) {
  const [table, setTable] = useState(false);
  const has = days.some((day) => day.satisfaction !== null);
  return (
    <Section
      title={<NounTitle icon={ChartLine}>Satisfaction day by day</NounTitle>}
      actions={
        has ? (
          <Button variant="ghost" size="sm" onClick={() => setTable(!table)}>
            {table ? "Show chart" : "Show table"}
          </Button>
        ) : null
      }
    >
      {!has ? (
        <EmptyState
          icon={ChartLine}
          title="Nothing to chart yet"
          description="The line appears once people say how a turn went, in their words or in what the agent's next reply shows."
        />
      ) : (
        <div className="flex flex-col gap-3" data-sentiment-daily="">
          {table ? null : (
            <div aria-hidden className="flex items-center gap-2 text-xs text-fg-subtle">
              <span>Unsatisfied</span>
              <span
                className="h-1.5 w-28 rounded-full"
                style={{
                  background: `linear-gradient(to right, ${MOOD_STOPS.map((stop) => `${stop.color} ${stop.at * 100}%`).join(", ")})`,
                }}
              />
              <span>Satisfied</span>
            </div>
          )}
          {table ? <DayTable days={days} /> : <Plot days={days} />}
        </div>
      )}
    </Section>
  );
}

function readout(day: DayPoint): string {
  const average =
    day.satisfaction === null
      ? "no answers"
      : `${percent(day.satisfaction)} over ${SMOOTHING_DAYS} days (${plural(day.windowAnswers, "answer")})`;
  return `${day.day}. Satisfaction: ${average}. That day: ${plural(day.answers, "answer")}, ${day.satisfied} satisfied.`;
}

function Plot({ days }: { days: readonly DayPoint[] }) {
  const [active, setActive] = useState<number | null>(null);
  const last = days.length - 1;
  const x = (at: number) => LEFT + (last > 0 ? (at * PLOT_WIDTH) / last : PLOT_WIDTH / 2);
  const y = (rate: number) => PAD_TOP + (1 - rate) * (PLOT_BOTTOM - PAD_TOP);
  const tick = labelEvery(days.length, 6);
  const values = days.map((day) => day.satisfaction);
  const points = values.map((value, at): [number, number] => [x(at), y(value ?? 0)]);
  const shown = active !== null && values[active] !== null ? points[active] : null;
  const gradient = `sentiment-mood-${useId().replace(/:/g, "")}`;
  return (
    <div
      role="group"
      aria-label="Satisfaction day by day. Use the arrow keys to read each day."
      tabIndex={0}
      onFocus={() => setActive(last)}
      onBlur={() => setActive(null)}
      onPointerLeave={() => setActive(null)}
      onPointerMove={(event) => {
        const plot = event.currentTarget.querySelector("svg");
        if (!plot || last < 0) return;
        const rect = plot.getBoundingClientRect();
        const at =
          ((((event.clientX - rect.left) / rect.width) * WIDTH - LEFT) / PLOT_WIDTH) * last;
        setActive(Math.max(0, Math.min(last, Math.round(at))));
      }}
      onKeyDown={(event) => {
        const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
        if (!step && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        setActive(
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : Math.max(0, Math.min(last, (active ?? last) + step)),
        );
      }}
      className="relative rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      {[0, 0.5, 1].map((rate) => (
        <span
          key={rate}
          aria-hidden
          className="pointer-events-none absolute left-0 text-xs text-fg-subtle"
          style={{ top: y(rate) - 8 }}
        >
          {rate * 100}%
        </span>
      ))}
      <div className="relative pl-10">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          width="100%"
          height={HEIGHT}
          preserveAspectRatio="none"
          aria-hidden
        >
          <defs>
            {/* Along the days: the whole height over a day is that day's color. */}
            <linearGradient
              id={gradient}
              gradientUnits="userSpaceOnUse"
              x1={x(0)}
              x2={x(Math.max(1, last))}
              y1={0}
              y2={0}
            >
              {dayStops(values).map((stop) => (
                <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
              ))}
            </linearGradient>
          </defs>
          {[0, 0.5, 1].map((rate) => (
            <line
              key={rate}
              x1={LEFT}
              x2={WIDTH - LEFT}
              y1={y(rate)}
              y2={y(rate)}
              stroke="var(--ds-line)"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {gapSegments(values).map((segment) => {
            const run = segment.map((at) => points[at]!);
            return (
              <g key={segment[0]}>
                <path d={areaPath(run, PLOT_BOTTOM)} fill={`url(#${gradient})`} opacity={0.28} />
                <path
                  d={smoothPath(run)}
                  fill="none"
                  stroke={`url(#${gradient})`}
                  strokeWidth={2.5}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
          {active !== null ? (
            <line
              x1={x(active)}
              x2={x(active)}
              y1={PAD_TOP - 4}
              y2={PLOT_BOTTOM}
              stroke="var(--ds-fg-subtle)"
              strokeDasharray="2 3"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        {/* The hovered day's marker, outside the stretched SVG so it stays round. */}
        {shown ? (
          <span
            aria-hidden
            className="pointer-events-none absolute top-0 left-10 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
            style={{
              marginLeft: `calc((100% - 2.5rem) * ${shown[0] / WIDTH})`,
              marginTop: shown[1],
              background: moodColor(values[active!]!),
              borderColor: "var(--ds-app)",
            }}
          />
        ) : null}
        <div className="relative h-4 text-xs text-fg-subtle" aria-hidden>
          {days.map((day, at) =>
            tick(at) ? (
              <span
                key={day.day}
                className={cn(
                  "absolute whitespace-nowrap tabular-nums",
                  at === last ? "-translate-x-full" : at > 0 && "-translate-x-1/2",
                )}
                style={{ left: `${(x(at) / WIDTH) * 100}%` }}
              >
                {dayLabel(day.day)}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <p className="mt-2 min-h-5 text-xs text-fg-muted" aria-live="polite">
        {active === null
          ? "Point to a day or use the arrow keys to read it."
          : readout(days[active]!)}
      </p>
    </div>
  );
}

function DayTable({ days }: { days: readonly DayPoint[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-ui tabular-nums">
        <caption className="sr-only">Satisfaction day by day</caption>
        <thead className="border-b border-line text-xs text-fg-subtle">
          <tr>
            <th scope="col" className="py-2 font-medium">
              Day (UTC)
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Answers that day
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Satisfied that day
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Satisfaction, {SMOOTHING_DAYS}-day average
            </th>
          </tr>
        </thead>
        <tbody>
          {[...days].reverse().map((day) => (
            <tr key={day.day} className="border-b border-line">
              <th scope="row" className="py-2 font-normal text-fg-muted">
                {day.day}
              </th>
              <td className="px-3 py-2 text-right text-fg">{day.answers}</td>
              <td className="px-3 py-2 text-right text-fg">{day.satisfied}</td>
              <td className="px-3 py-2 text-right text-fg">
                {day.satisfaction === null ? "None" : percent(day.satisfaction)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A day as "Nov 3". */
function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
