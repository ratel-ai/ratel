"use client";

import { cn } from "@ratel/design-system/cn";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { TaskPin } from "@ratel/design-system/entity";
import { Section } from "@ratel/design-system/section";
import { StepKindPin } from "@ratel/design-system/step-kind";
import Link from "next/link";
import type { ReactNode } from "react";
import type {
  KindRow,
  MeasureRow,
  RouteRow,
  StepPreset,
  StepKindTables as Tables,
  TaskRow,
} from "@/lib/readings/trace-signals/steps/tables";
import type { StepsView } from "@/lib/readings/trace-signals/steps/view";

/**
 * Agent health per step kind (RC-1078, `cloud-typed-steps`): how each kind of
 * step behaves, then the detail of the kinds that have one (model calls,
 * handoffs, user messages) and the tasks. The `?steps=` preset picks the kinds.
 */

const KIND_COLUMNS: readonly Column<KindRow>[] = [
  { id: "kind", header: "Kind", cell: (row) => <StepKindPin kind={row.kind} name={row.label} /> },
  { id: "count", header: "Steps", cell: (row) => row.count, align: "right", width: "6rem" },
  {
    id: "per_run",
    header: "Per run",
    cell: (row) => row.perRun,
    align: "right",
    width: "6rem",
    hiddenBelow: "sm",
  },
  { id: "failed", header: "Failed", cell: (row) => row.failed, align: "right", width: "6rem" },
  {
    id: "slow",
    header: "Time, 95% under",
    cell: (row) => row.slow,
    align: "right",
    width: "9rem",
    hiddenBelow: "md",
  },
  {
    id: "retries",
    header: "Retried",
    cell: (row) => row.retries,
    align: "right",
    width: "6rem",
    hiddenBelow: "md",
  },
  {
    id: "detail",
    header: "Detail",
    cell: (row) => <span className="text-fg-muted">{row.detail}</span>,
    hiddenBelow: "lg",
  },
];

const MEASURE_COLUMNS: readonly Column<MeasureRow>[] = [
  { id: "label", header: "Measure", cell: (row) => row.label },
  { id: "value", header: "Value", cell: (row) => row.value, align: "right", width: "12rem" },
];

const ROUTE_COLUMNS: readonly Column<RouteRow>[] = [
  { id: "from", header: "From", cell: (row) => row.from },
  { id: "to", header: "To", cell: (row) => <StepKindPin kind="handoff" name={row.to} /> },
  { id: "count", header: "Handoffs", cell: (row) => row.count, align: "right", width: "7rem" },
  {
    id: "failed",
    header: "Receiving run failed",
    cell: (row) => row.failed,
    align: "right",
    width: "11rem",
  },
];

const TASK_COLUMNS: readonly Column<TaskRow>[] = [
  { id: "task", header: "Task", cell: (row) => <TaskPin name={row.name} slot={null} /> },
  { id: "runs", header: "Runs", cell: (row) => row.runs, align: "right", width: "5rem" },
  {
    id: "finished",
    header: "Finished",
    cell: (row) => row.finished,
    align: "right",
    width: "6rem",
  },
  {
    id: "cost",
    header: "Cost per run",
    cell: (row) => row.costPerRun,
    align: "right",
    width: "7rem",
    hiddenBelow: "sm",
  },
  {
    id: "duration",
    header: "Typical time",
    cell: (row) => row.duration,
    align: "right",
    width: "7rem",
    hiddenBelow: "md",
  },
  {
    id: "corrections",
    header: "Self-corrections per 100 runs",
    cell: (row) => row.corrections,
    align: "right",
    width: "8rem",
    hiddenBelow: "md",
  },
  {
    id: "weakest",
    header: "Weakest step",
    cell: (row) =>
      row.weakest ? (
        <span className="inline-flex min-w-0 items-center gap-2">
          <StepKindPin kind={row.weakest.kind} name={row.weakest.name} />
          <span className="text-fg-muted tabular-nums">{row.weakest.failed} failed</span>
        </span>
      ) : (
        <span className="text-fg-subtle">None failed</span>
      ),
    hiddenBelow: "lg",
  },
];

export function StepKindTables({
  tables,
  view,
  presets,
}: {
  tables: Tables;
  view: StepsView;
  presets: readonly StepPreset[];
}) {
  return (
    <Section title="Steps by kind" actions={<StepsPresetSwitch view={view} presets={presets} />}>
      <div className="flex flex-col gap-6" data-health-step-kinds={view}>
        <DataTable
          caption="Steps by kind"
          columns={KIND_COLUMNS}
          rows={tables.kinds}
          rowKey={(row) => row.kind}
          density="compact"
          empty={
            <p className="px-3 py-4 text-ui text-fg-muted">
              No steps of these kinds ran in this window.
            </p>
          }
        />
        {tables.model ? <MeasureTable title="Model calls" rows={tables.model} /> : null}
        {tables.routes && tables.routes.length > 0 ? (
          <SubTable title="Handoffs">
            <DataTable
              caption="Handoffs"
              columns={ROUTE_COLUMNS}
              rows={tables.routes}
              rowKey={(row) => row.key}
              density="compact"
            />
          </SubTable>
        ) : null}
        {tables.messages ? <MeasureTable title="User messages" rows={tables.messages} /> : null}
        {tables.tasks.length > 0 ? (
          <SubTable title="Tasks">
            <DataTable
              caption="Tasks"
              columns={TASK_COLUMNS}
              rows={tables.tasks}
              rowKey={(row) => row.id}
              density="compact"
            />
          </SubTable>
        ) : null}
      </div>
    </Section>
  );
}

function MeasureTable({ title, rows }: { title: string; rows: readonly MeasureRow[] }) {
  return (
    <SubTable title={title}>
      <DataTable
        caption={title}
        columns={MEASURE_COLUMNS}
        rows={rows}
        rowKey={(row) => row.label}
        density="compact"
      />
    </SubTable>
  );
}

function SubTable({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-ui font-medium text-fg-muted">{title}</h3>
      {children}
    </div>
  );
}

/** The `?steps=` presets, as links in the segmented look of the window switch. */
function StepsPresetSwitch({ view, presets }: { view: StepsView; presets: readonly StepPreset[] }) {
  const item =
    "inline-flex h-6 items-center rounded-[4px] px-2 text-ui font-medium whitespace-nowrap outline-none transition-colors duration-120 focus-visible:ring-2 focus-visible:ring-focus";
  return (
    <nav
      aria-label="Step kinds"
      className="inline-flex items-center gap-0.5 rounded-md border border-line bg-app p-0.5"
    >
      {presets.map((preset) => {
        const active = preset.view === view;
        return (
          <Link
            key={preset.view}
            href={preset.href}
            scroll={false}
            aria-current={active ? "true" : undefined}
            className={cn(item, active ? "bg-selected text-fg" : "text-fg-muted hover:text-fg")}
          >
            {preset.label}
          </Link>
        );
      })}
    </nav>
  );
}
