"use client";

import { Button } from "@ratel/design-system/button";
import { Section } from "@ratel/design-system/section";
import { Select } from "@ratel/design-system/select";
import { EmptyState } from "@ratel/design-system/states";
import { Tooltip } from "@ratel/design-system/tooltip";
import { ChartLine } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { gapSegments, smoothPath, toPoints } from "@/lib/platform/chart";
import { FINISHES_CLEANLY_HELP, SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import { SCORER_KINDS, type ScorerKind } from "@/lib/views/task-scorers/types";
import { ShipmentResults, type TaskShipment } from "./ShipmentResults";

export type ScoreChartRow = {
  day: string;
  scorerKind: ScorerKind | "overall";
  n: number;
  passed: number;
};
type ScoreIndex = ReadonlyMap<string, ScoreChartRow>;

const SCORE_LABELS = { ...SCORER_LABELS, judge_criteria: "Task criteria (sampled)" };
const WIDTH = 800;
const HEIGHT = 180;
const LEFT = 4;
const PLOT_WIDTH = WIDTH - LEFT * 2;
const PLOT_BOTTOM = 156;

export function ScoreChart({
  rows,
  today,
  shipments = [],
  projectId = "",
  taskId = "",
}: {
  rows: readonly ScoreChartRow[];
  today: string;
  shipments?: readonly TaskShipment[];
  projectId?: string;
  taskId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const search = useSearchParams();
  const requested = search.get("scoreScorer");
  const selected = SCORER_KINDS.find((kind) => kind === requested) ?? "ends_well";
  const table = search.get("scoreView") === "table";
  const days = Array.from({ length: 14 }, (_, index) =>
    new Date(Date.parse(`${today}T00:00:00Z`) - (13 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10),
  );
  const index = new Map(rows.map((row) => [`${row.day}:${row.scorerKind}`, row]));
  const series = ["overall", selected] as const;
  const color = `var(--ds-chart-${selected === "judge_criteria" ? 3 : SCORER_KINDS.indexOf(selected) + 1})`;
  const hasScores = rows.some((row) => row.n > 0 && row.day >= days[0]! && row.day <= today);

  function choose(key: string, value: string) {
    const url = new URL(window.location.href);
    url.searchParams.set(key, value);
    startTransition(() => router.replace(`${url.pathname}${url.search}`, { scroll: false }));
  }

  return (
    <Section
      title="Score"
      description="Daily pass rate for the last 14 days (UTC)."
      actions={
        <>
          <Select
            aria-label="Compare scorer"
            options={SCORER_KINDS.map((kind) => ({ value: kind, label: SCORE_LABELS[kind] }))}
            value={selected}
            disabled={pending}
            onValueChange={(value) => choose("scoreScorer", value)}
          />
          <Button
            variant="ghost"
            size="sm"
            loading={pending}
            onClick={() => choose("scoreView", table ? "chart" : "table")}
          >
            {table ? "Show chart" : "Show table"}
          </Button>
        </>
      }
    >
      {!hasScores ? (
        <EmptyState
          icon={ChartLine}
          title="No scored runs yet"
          description="Daily pass rates appear after the scoring job processes this task's runs."
        />
      ) : (
        <>
          <ul
            aria-label="Score legend"
            className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-fg-muted"
          >
            {series.map((kind) => (
              <li key={kind} className="inline-flex items-center gap-2">
                <span
                  aria-hidden
                  className="h-0.5 w-5"
                  style={{ background: kind === "overall" ? "var(--ds-fg-muted)" : color }}
                />
                {kind === "ends_well" ? (
                  <Tooltip content={FINISHES_CLEANLY_HELP}>
                    <span
                      tabIndex={0}
                      className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      {SCORE_LABELS[kind]}
                    </span>
                  </Tooltip>
                ) : (
                  SCORE_LABELS[kind]
                )}
              </li>
            ))}
          </ul>
          {table ? (
            <ScoreTable days={days} index={index} series={series} />
          ) : (
            <ScorePlot
              days={days}
              index={index}
              selected={selected}
              color={color}
              shipments={shipments}
            />
          )}
        </>
      )}
      {shipments.length > 0 ? (
        <ShipmentResults shipments={shipments} projectId={projectId} taskId={taskId} />
      ) : null}
    </Section>
  );
}

function ScoreTable({
  days,
  index,
  series,
}: {
  days: readonly string[];
  index: ScoreIndex;
  series: readonly (ScorerKind | "overall")[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm tabular-nums">
        <caption className="sr-only">Daily pass rates and measured run counts</caption>
        <thead className="border-b border-line text-xs text-fg-subtle">
          <tr>
            <th scope="col" className="py-2 font-medium">
              Day (UTC)
            </th>
            {series.map((kind) => (
              <th scope="col" key={kind} className="px-3 py-2 font-medium">
                {SCORE_LABELS[kind]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day} className="border-b border-line">
              <th scope="row" className="py-2 font-normal text-fg-muted">
                {day}
              </th>
              {series.map((kind) => (
                <td key={kind} className="px-3 py-2 text-fg">
                  {rateLabel(index.get(`${day}:${kind}`))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScorePlot({
  days,
  index,
  selected,
  color,
  shipments,
}: {
  days: string[];
  index: ScoreIndex;
  selected: ScorerKind;
  color: string;
  shipments: readonly TaskShipment[];
}) {
  const [active, setActive] = useState<number | null>(null);
  const series = ["overall", selected] as const;
  const x = (at: number) => LEFT + (at * PLOT_WIDTH) / (days.length - 1);
  const readout = (at: number) =>
    `${days[at]}. ${series.map((kind) => `${SCORE_LABELS[kind]}: ${rateLabel(index.get(`${days[at]}:${kind}`))}`).join(". ")}`;
  return (
    <Tooltip content={active === null ? "Point to a day to read its score" : readout(active)}>
      <div
        role="group"
        aria-label="Daily pass rates. Use the arrow keys to read each day."
        tabIndex={0}
        onFocus={() => setActive(days.length - 1)}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        onPointerMove={(event) => {
          const plot = event.currentTarget.querySelector("svg");
          if (!plot) return;
          const rect = plot.getBoundingClientRect();
          const at =
            ((((event.clientX - rect.left) / rect.width) * WIDTH - LEFT) / PLOT_WIDTH) *
            (days.length - 1);
          setActive(Math.max(0, Math.min(days.length - 1, Math.round(at))));
        }}
        onKeyDown={(event) => {
          const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
          if (!step && event.key !== "Home" && event.key !== "End") return;
          event.preventDefault();
          setActive(
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? days.length - 1
                : Math.max(0, Math.min(days.length - 1, (active ?? days.length - 1) + step)),
          );
        }}
        className="relative rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {[0, 0.5, 1].map((rate) => (
          <span
            key={rate}
            aria-hidden
            className="pointer-events-none absolute left-0 text-xs text-fg-subtle"
            style={{ top: 4 + (1 - rate) * (PLOT_BOTTOM - 12) }}
          >
            {rate * 100}%
          </span>
        ))}
        <div className="pl-10">
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            width="100%"
            height={HEIGHT}
            preserveAspectRatio="none"
            aria-hidden
          >
            {[0, 0.5, 1].map((rate) => {
              const y = 12 + (1 - rate) * (PLOT_BOTTOM - 12);
              return (
                <line
                  key={rate}
                  x1={LEFT}
                  x2={WIDTH - LEFT}
                  y1={y}
                  y2={y}
                  stroke="var(--ds-line)"
                />
              );
            })}
            {series.map((kind) => (
              <ScoreLine key={kind} days={days} index={index} kind={kind} color={color} />
            ))}
            {shipments.map((shipment) => {
              const day = shipment.shippedAt.slice(0, 10);
              const at = days.indexOf(day);
              if (at < 0) return null;
              const measured = shipment.comparison?.[selected]?.actual.passRate;
              return (
                <g key={shipment.id}>
                  <title>{`Live in ${shipment.version} on ${day}${measured != null ? `. Live result: ${Math.round(measured * 100)}%` : ". Waiting for measurement"}`}</title>
                  <line
                    x1={x(at)}
                    x2={x(at)}
                    y1={8}
                    y2={PLOT_BOTTOM}
                    stroke="var(--ds-fg-subtle)"
                    strokeDasharray="4 4"
                  />
                  <rect x={x(at) - 4} y={4} width={8} height={8} fill="var(--ds-fg-muted)" />
                  {measured != null ? (
                    <circle
                      cx={x(at)}
                      cy={12 + (1 - measured) * (PLOT_BOTTOM - 12)}
                      r={5}
                      fill={color}
                      stroke="var(--ds-bg-app)"
                      strokeWidth={2}
                    />
                  ) : null}
                </g>
              );
            })}
            {active !== null ? (
              <line
                x1={x(active)}
                x2={x(active)}
                y1={8}
                y2={PLOT_BOTTOM}
                stroke="var(--ds-fg-subtle)"
                strokeDasharray="2 3"
              />
            ) : null}
          </svg>
          <div className="flex justify-between text-xs text-fg-subtle">
            <span>{days[0]}</span>
            <span>{days.at(-1)}</span>
          </div>
        </div>
        <p className="mt-2 min-h-5 text-xs text-fg-muted" aria-live="polite">
          {active === null
            ? "Point to a day or use the arrow keys to read its score."
            : readout(active)}
        </p>
      </div>
    </Tooltip>
  );
}

function ScoreLine({
  days,
  index,
  kind,
  color,
}: {
  days: readonly string[];
  index: ScoreIndex;
  kind: ScorerKind | "overall";
  color: string;
}) {
  const values = days.map((day) => {
    const row = index.get(`${day}:${kind}`);
    return row && row.n > 0 ? row.passed / row.n : null;
  });
  const points = toPoints(
    values.map((value) => value ?? 0),
    { width: PLOT_WIDTH, height: PLOT_BOTTOM, padTop: 12, max: 1 },
  ).map(([px, py]): [number, number] => [px + LEFT, py]);
  return (
    <g stroke={kind === "overall" ? "var(--ds-fg-muted)" : color}>
      {gapSegments(values).map((segment) => (
        <path
          key={segment[0]}
          d={smoothPath(segment.map((at) => points[at]!))}
          fill="none"
          strokeWidth={2}
          strokeDasharray={kind === "overall" ? "5 4" : undefined}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {points.map(([px, py], at) =>
        values[at] === null ? null : (
          <path
            key={at}
            d={`M${px},${py}h0.01`}
            strokeLinecap="round"
            strokeWidth={8}
            vectorEffect="non-scaling-stroke"
          />
        ),
      )}
    </g>
  );
}

function rateLabel(row?: ScoreChartRow): string {
  return row && row.n > 0
    ? `${Math.round((row.passed / row.n) * 100)}% (${row.passed}/${row.n})`
    : "No data";
}
