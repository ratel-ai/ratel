"use client";

import { cn } from "@ratel/design-system/cn";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { SegmentedControl } from "@ratel/design-system/tabs";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type PivotGroupRowView, withGroupPivot } from "@/lib/synthesis/pivots/group-by-view";
import type { PivotFilterOption } from "@/lib/synthesis/traces/v2/filters";
import {
  formatDuration,
  formatInteger,
  formatMoney,
  formatPercent,
} from "@/lib/synthesis/traces/v2/format";

const QUIET_LINK =
  "text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg-subtle";

/**
 * The rows of Overview's pivot group-by (RC-886), and the pivot picker when
 * more than one pivot is configured. A value opens Sessions filtered by it.
 */
export function PivotBreakdownTable({
  pivots,
  pivotKey,
  pivotLabel,
  rows,
}: {
  pivots: readonly PivotFilterOption[];
  pivotKey: string;
  pivotLabel: string;
  rows: readonly PivotGroupRowView[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const columns: readonly Column<PivotGroupRowView>[] = [
    {
      id: "value",
      header: pivotLabel,
      cell: (row) =>
        row.href ? (
          <Link href={row.href} className={cn("truncate", QUIET_LINK)} title={row.label}>
            {row.label}
          </Link>
        ) : (
          <span className="text-fg-muted">{row.label}</span>
        ),
    },
    {
      id: "runs",
      header: "Runs",
      align: "right",
      width: "7rem",
      cell: (row) => formatInteger(row.runs),
    },
    {
      id: "share",
      header: "Share",
      align: "right",
      width: "6rem",
      hiddenBelow: "sm",
      cell: (row) => formatPercent(row.share),
    },
    {
      id: "errors",
      header: "Error rate",
      align: "right",
      width: "7rem",
      cell: (row) => formatPercent(row.errorRate),
    },
    {
      id: "p50",
      header: "p50",
      align: "right",
      width: "7rem",
      hiddenBelow: "sm",
      cell: (row) => formatDuration(row.p50Ms),
    },
    {
      id: "cost",
      header: "Cost",
      align: "right",
      width: "7rem",
      cell: (row) => formatMoney(row.costUsd),
    },
  ];
  return (
    <div className="flex flex-col gap-3" data-pivot-breakdown={pivotKey}>
      {pivots.length > 1 ? (
        <SegmentedControl
          label="Group runs by"
          value={pivotKey}
          onValueChange={(key) =>
            router.replace(`${pathname}${withGroupPivot(search.toString(), key)}`, {
              scroll: false,
            })
          }
          options={pivots.map((pivot) => ({ value: pivot.key, label: pivot.label }))}
        />
      ) : null}
      <div className="rounded-lg border border-line">
        <DataTable
          caption={`Runs by ${pivotLabel.toLowerCase()}`}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.key}
          density="compact"
          empty={<p className="px-4 py-6 text-ui text-fg-subtle">No runs in this window.</p>}
        />
      </div>
    </div>
  );
}
