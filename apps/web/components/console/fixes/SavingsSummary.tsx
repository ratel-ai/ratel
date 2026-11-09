"use client";

import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Disclosure } from "@ratel/design-system/disclosure";
import { StatRow } from "@ratel/design-system/stat-row";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { Tooltip } from "@ratel/design-system/tooltip";
import Link from "next/link";
import { formatDuration } from "@/lib/readings/tool-explorer/view";
import { formatTokens } from "@/lib/synthesis/tool-crafter/suggestion-model";
import { formatMoney, formatPercent } from "@/lib/synthesis/traces/v2/format";
import { SAVINGS_PERIODS, savingsForPeriod } from "@/lib/views/fixes/period";
import type {
  FixSavings,
  FixSavingsEntry,
  FixSavingsSummary,
  FixTaskRef,
} from "@/lib/views/fixes/types";
import { useSavingsPeriod } from "./url";

type SavingsRow = FixSavingsEntry & { task: FixTaskRef };

const METRICS = [
  {
    key: "tokens",
    label: "Tokens saved",
    format: (value: number) => `${formatTokens(value)} tokens`,
  },
  { key: "usd", label: "Cost saved", format: formatMoney },
  { key: "ms", label: "Waiting saved", format: formatDuration },
] as const;
const PERIOD_OPTIONS = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;

/** Show the supplied rates as totals and a task breakdown for one period. */
export function SavingsSummary({ savings }: { savings: FixSavingsSummary }) {
  const [period, setPeriod] = useSavingsPeriod();
  const periodLabel = SAVINGS_PERIODS[period].label;
  const total = savingsForPeriod(savings.total.absolute, savings.total.windowDays, period);
  const rows = savings.tasks.map((entry) => ({
    ...entry,
    absolute: savingsForPeriod(entry.absolute, entry.windowDays, period),
  }));
  const columns: Column<SavingsRow>[] = [
    {
      id: "task",
      header: "Task",
      cell: ({ task }) => (
        <Link
          href={task.href}
          className="rounded-md text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
        >
          {task.label}
        </Link>
      ),
    },
    ...METRICS.map(
      ({ key, label, format }): Column<SavingsRow> => ({
        id: key,
        header: `${label} ${periodLabel}`,
        align: "right",
        className: "whitespace-nowrap",
        cell: (row) => <SavingsValue entry={row} metric={key} format={format} />,
      }),
    ),
  ];
  return (
    <section aria-labelledby="fix-savings-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="fix-savings-heading" className="text-sm font-semibold text-fg">
          Potential savings
        </h2>
        <SegmentedControl
          label="Savings period"
          options={PERIOD_OPTIONS}
          value={period}
          onValueChange={setPeriod}
        />
      </div>
      <StatRow
        stats={METRICS.map(({ key, label, format }) => ({
          label,
          value: total[key] === null ? "Not measured" : format(total[key]),
          hint: (
            <>
              {periodLabel}
              {period === "month" ? " (30 days)" : ""}
              {savings.total.relative[key] !== null ? (
                <>
                  {" "}
                  · <SavingsShare value={savings.total.relative[key]} /> of project usage
                </>
              ) : null}
            </>
          ),
        }))}
      />
      <Disclosure title="Savings by task" hint={`${savings.tasks.length} tasks · ${periodLabel}`}>
        <DataTable
          caption={`Potential savings by task ${periodLabel}`}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.task.id}
        />
      </Disclosure>
    </section>
  );
}

function SavingsValue({
  entry,
  metric,
  format,
}: {
  entry: FixSavingsEntry;
  metric: keyof FixSavings;
  format: (value: number) => string;
}) {
  const absolute = entry.absolute[metric];
  const relative = entry.relative[metric];
  if (absolute === null) return <span className="text-fg-faint">Not measured</span>;
  return (
    <span className="text-fg tabular-nums">
      {absolute === 0 ? "" : "−"}
      {format(absolute)}
      {relative !== null ? (
        <span className="text-fg-subtle">
          {" "}
          (<SavingsShare value={relative} />)
        </span>
      ) : null}
    </span>
  );
}

function SavingsShare({ value }: { value: number }) {
  if (value <= 1) return <>{formatPercent(value)}</>;
  return (
    <Tooltip content="The estimated saving rate exceeds measured usage. A fix can cover several tasks, and savings and usage can come from different measurement windows.">
      <span
        tabIndex={0}
        className="rounded-sm underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        100%+
      </span>
    </Tooltip>
  );
}
