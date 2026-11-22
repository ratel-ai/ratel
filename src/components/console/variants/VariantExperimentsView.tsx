"use client";

import { Badge } from "@ratel/design-system/badge";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { Split } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DateRangeControl } from "@/components/console/calibration/DateRangeControl";
import type { RangePreset } from "@/lib/synthesis/dashboard";
import { formatInteger, formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { VariantExperimentSummary } from "@/lib/views/variants/compare-service";

/** An experiment row as the page sends it, with its page. */
export type VariantExperimentItem = VariantExperimentSummary & { href: string };

export interface VariantsRange {
  preset: RangePreset | "custom";
  from: string;
  to: string;
}

/** Variant badges shown in a row before "+N more". */
const VARIANTS_SHOWN = 4;

/**
 * The variant experiments (RC-871): "Which experiments run, with which
 * variants, and how much traffic does each get?" One row per experiment.
 */
export function VariantExperimentsView({
  experiments,
  truncated,
  range,
  clamped,
  now,
}: {
  /** Null when the read failed: unknown, not empty. */
  experiments: readonly VariantExperimentItem[] | null;
  truncated: boolean;
  range: VariantsRange;
  clamped: boolean;
  now: string;
}) {
  const router = useRouter();
  const columns: Column<VariantExperimentItem>[] = [
    {
      id: "experiment",
      header: "Experiment",
      cell: (row) => (
        <Link
          href={row.href}
          className="truncate font-medium text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
        >
          {row.experiment}
        </Link>
      ),
    },
    {
      id: "variants",
      header: "Variants",
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          {row.variants.slice(0, VARIANTS_SHOWN).map((variant) => (
            <Badge key={variant.name}>
              {variant.name}{" "}
              <span className="tabular-nums text-fg-subtle">{formatInteger(variant.runs)}</span>
            </Badge>
          ))}
          {row.variants.length > VARIANTS_SHOWN ? (
            <span className="text-xs text-fg-subtle">
              +{row.variants.length - VARIANTS_SHOWN} more
            </span>
          ) : null}
        </span>
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
      id: "last",
      header: "Last run",
      align: "right",
      width: "8rem",
      hiddenBelow: "md",
      cell: (row) => formatRelativeTime(row.lastSeenAt, now),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Variants"
        actions={
          <DateRangeControl
            preset={range.preset}
            from={range.from}
            to={range.to}
            alignPicker="end"
            unified
          />
        }
      />
      <PageBody wide>
        {experiments === null ? (
          <Callout tone="danger" title="Variant experiments could not be read">
            Reload the page. If it fails again, try a shorter window.
          </Callout>
        ) : (
          <div className="flex flex-col gap-4">
            {clamped || truncated ? (
              <Callout tone="info">
                {clamped ? "Showing the last 30 days of this range. " : ""}
                {truncated ? "Only the most recent experiments are listed." : ""}
              </Callout>
            ) : null}
            <DataTable
              caption="Variant experiments"
              columns={columns}
              rows={experiments}
              rowKey={(row) => row.experiment}
              onRowOpen={(row) => router.push(row.href)}
              empty={
                <EmptyState
                  icon={Split}
                  title="No variant experiments in this window"
                  description="Tag your traces with ratel.variant.experiment and ratel.variant.name to compare variants of your agent here."
                />
              }
            />
          </div>
        )}
      </PageBody>
    </Page>
  );
}
