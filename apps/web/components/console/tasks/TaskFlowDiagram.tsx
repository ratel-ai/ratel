import { useId } from "react";
import type { IntentFlowLayout } from "@/lib/views/tasks/flow-layout";
import { formatCount, formatSharePercent } from "@/lib/views/tasks/format";

/** The arrow's label pill; the layout keeps labels this size apart (`flow-layout.ts`). */
const LABEL_W = 40;
const LABEL_H = 18;
/** The share bar inside a tool's box. */
const BAR_INSET = 10;
const BAR_H = 3;

/**
 * How a task's runs move between its steps, as a layered diagram (Tool
 * craft's drawing of one ask, now of one task, `buildIntentFlow`): a column
 * per step, a box per tool with the share of the task's runs that called it,
 * and an arrow per hop labelled with how often the next tool followed. An
 * arrow under the diagram runs against the usual order. Drawn at its natural
 * size, so its text never shrinks below 12 px; a wide task scrolls sideways
 * inside its frame. Grays for structure, the task's own color for the share
 * bars (its identity, `lib/tasks/palette.ts`). Tool names only: no request
 * text.
 */
export function TaskFlowDiagram({
  runs,
  layout,
  barClass = "fill-chart-1",
}: {
  runs: number;
  layout: IntentFlowLayout;
  barClass?: string;
}) {
  // Two diagrams can share a page, so arrowhead ids are per instance.
  const markerId = useId();
  if (layout.nodes.length === 0) return null;
  const label = (id: string) => layout.nodes.find((node) => node.id === id)?.label ?? id;
  return (
    <div
      tabIndex={0}
      role="group"
      aria-label="How runs move between the steps"
      className="overflow-x-auto rounded-lg border border-line bg-app dot-grid outline-none focus-visible:ring-2 focus-visible:ring-focus"
      data-task-flow=""
      data-task-flow-columns={layout.columns}
    >
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        role="img"
        aria-label="Each step with the share of runs that called it, and how often each next step followed"
        className="block select-none"
      >
        <defs>
          <marker
            id={`${markerId}-arrow`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0 0 L10 5 L0 10 z" className="fill-fg-subtle" />
          </marker>
        </defs>
        {layout.arrows.map((arrow) => (
          <g
            key={`${arrow.a}>${arrow.b}`}
            data-flow-arrow={`${arrow.a}>${arrow.b}`}
            data-flow-strong={arrow.strong ? "true" : undefined}
            data-flow-span={arrow.span}
          >
            <title>{`Of ${formatCount(arrow.na)} visits to ${label(arrow.a)}, ${label(arrow.b)} came next in ${formatCount(arrow.n)}`}</title>
            <path
              d={arrow.d}
              className="fill-none stroke-fg-subtle"
              strokeWidth={1 + 1.25 * arrow.p}
              strokeOpacity={0.5 + 0.5 * arrow.p}
              strokeLinecap="round"
              markerEnd={`url(#${markerId}-arrow)`}
            />
          </g>
        ))}
        {layout.nodes.map((node) => {
          const share = runs > 0 ? Math.min(1, node.units / runs) : 0;
          return (
            <g key={node.id} data-flow-node={node.id} data-flow-column={node.column}>
              <title>{`${node.label}: called in ${formatCount(node.units)} of ${formatCount(runs)} runs`}</title>
              <rect
                x={node.x}
                y={node.y}
                width={node.w}
                height={node.h}
                rx={6}
                className="fill-raised stroke-line-strong"
              />
              <rect
                x={node.x + BAR_INSET}
                y={node.y + node.h - 8}
                width={node.w - BAR_INSET * 2}
                height={BAR_H}
                rx={1.5}
                className="fill-line"
              />
              <rect
                x={node.x + BAR_INSET}
                y={node.y + node.h - 8}
                width={Math.max(2, (node.w - BAR_INSET * 2) * share)}
                height={BAR_H}
                rx={1.5}
                className={barClass}
              />
              <text
                x={node.x + node.w / 2}
                y={node.y + 17}
                textAnchor="middle"
                className="fill-fg font-mono text-xs"
              >
                {node.label}
              </text>
              <text
                x={node.x + node.w / 2}
                y={node.y + 31}
                textAnchor="middle"
                className="fill-fg-subtle text-xs tabular-nums"
              >
                {runs > 0 ? formatSharePercent(share) : ""}
              </text>
            </g>
          );
        })}
        {layout.arrows.map((arrow) => (
          <g key={`label:${arrow.a}>${arrow.b}`} data-flow-label={`${arrow.a}>${arrow.b}`}>
            <rect
              x={arrow.labelX - LABEL_W / 2}
              y={arrow.labelY - LABEL_H / 2}
              width={LABEL_W}
              height={LABEL_H}
              rx={LABEL_H / 2}
              className="fill-app stroke-line-strong"
            />
            <text
              x={arrow.labelX}
              y={arrow.labelY}
              textAnchor="middle"
              dominantBaseline="central"
              className="fill-fg text-xs tabular-nums"
            >
              {formatSharePercent(arrow.p)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
