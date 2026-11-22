"use client";

import { Badge } from "@ratel/design-system/badge";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { DateRangeControl } from "@/components/console/calibration/DateRangeControl";
import {
  formatCompact,
  formatDuration,
  formatInteger,
  formatPercent,
} from "@/lib/synthesis/traces/v2/format";
import type { VariantComparisonResult } from "@/lib/views/variants/compare-service";
import {
  type CheaperSuggestion,
  type Estimate,
  HEALTH_KINDS,
  type HealthKind,
  type Rate,
  type VariantMetrics,
} from "@/lib/views/variants/domain/compare";
import type { VariantsRange } from "./VariantExperimentsView";

const HEALTH_LABEL: Readonly<Record<HealthKind, string>> = {
  tool_errors: "Tool errors",
  self_corrections: "Self-corrections",
  abandoned: "Abandoned",
  detours: "Detours",
};

/** Descriptors shown under a variant's name, when its traces carry them. */
const DESCRIPTORS_SHOWN = ["model", "prompt_version"] as const;

/**
 * One variant experiment (RC-871): "How does each variant do, and is a
 * cheaper one safe?" One row per variant with each figure and its 95% range,
 * the baseline marked, a warning for a variant with too few runs, and the
 * cheaper-variant suggestion with the figures behind it.
 */
export function VariantComparisonView({
  experiment,
  comparison,
  failed,
  listHref,
  range,
  clamped,
}: {
  experiment: string;
  /** Null: no tagged run in the window, or the read failed (`failed`). */
  comparison: VariantComparisonResult | null;
  failed: boolean;
  listHref: string;
  range: VariantsRange;
  clamped: boolean;
}) {
  return (
    <Page>
      <PageHeader
        title={experiment}
        crumbs={[{ label: "Variants", href: listHref }]}
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
        {comparison ? (
          <ComparisonBody comparison={comparison} clamped={clamped} />
        ) : failed ? (
          <Callout tone="danger" title="This experiment could not be read">
            Reload the page. If it fails again, try a shorter window.
          </Callout>
        ) : (
          <EmptyState
            title="No runs of this experiment in this window"
            description="Widen the window to see its variants."
          />
        )}
      </PageBody>
    </Page>
  );
}

function ComparisonBody({
  comparison,
  clamped,
}: {
  comparison: VariantComparisonResult;
  clamped: boolean;
}) {
  const byName = new Map(comparison.variants.map((variant) => [variant.name, variant]));
  const small = comparison.variants.filter((variant) => variant.belowMinimumSample);
  const healthKinds = HEALTH_KINDS.filter((kind) =>
    comparison.variants.some((variant) => variant.health.some((signal) => signal.kind === kind)),
  );

  const columns: Column<VariantMetrics>[] = [
    { id: "variant", header: "Variant", cell: (row) => <VariantName variant={row} /> },
    {
      id: "runs",
      header: "Runs",
      align: "right",
      width: "6rem",
      cell: (row) => formatInteger(row.runs),
    },
    {
      id: "errors",
      header: "Error rate",
      align: "right",
      width: "8rem",
      cell: (row) => <RateCell rate={row.errorRate} />,
    },
    {
      id: "p50",
      header: "p50",
      align: "right",
      width: "7rem",
      cell: (row) => <EstimateCell estimate={row.latencyP50Ms} format={formatDuration} />,
    },
    {
      id: "p95",
      header: "p95",
      align: "right",
      width: "7rem",
      cell: (row) => <EstimateCell estimate={row.latencyP95Ms} format={formatDuration} />,
    },
    {
      id: "tokens",
      header: "Tokens per run",
      align: "right",
      width: "10rem",
      hiddenBelow: "lg",
      cell: (row) => (
        <Figure
          value={formatInteger(row.tokens.perRun)}
          sub={`${formatCompact(row.tokens.input)} in · ${formatCompact(row.tokens.output)} out`}
        />
      ),
    },
    {
      id: "cost",
      header: "Cost per success",
      align: "right",
      width: "11rem",
      cell: (row) => <EstimateCell estimate={row.costPerSuccessUsd} format={formatCost} />,
    },
    {
      id: "scorers",
      header: "Scorer pass rate",
      align: "right",
      width: "9rem",
      cell: (row) => <RateCell rate={row.scorerPassRate} />,
    },
  ];
  const healthColumns: Column<VariantMetrics>[] = [
    { id: "variant", header: "Variant", cell: (row) => <VariantName variant={row} /> },
    ...healthKinds.map((kind) => ({
      id: kind,
      header: HEALTH_LABEL[kind],
      align: "right" as const,
      width: "9rem",
      cell: (row: VariantMetrics) => (
        <RateCell rate={row.health.find((signal) => signal.kind === kind)?.rate ?? null} />
      ),
    })),
  ];

  return (
    <div className="flex flex-col gap-6">
      {comparison.suggestions.map((suggestion) => (
        <SuggestionCallout
          key={suggestion.variant}
          suggestion={suggestion}
          variant={byName.get(suggestion.variant)!}
          baseline={byName.get(suggestion.baseline)!}
        />
      ))}
      {small.length > 0 ? (
        <Callout
          tone="warning"
          title={
            small.length === 1
              ? `${small[0]!.name} has too few runs to compare`
              : `${small.length} variants have too few runs to compare`
          }
        >
          A variant needs {comparison.minimumSample} runs in the window before its figures are
          compared or suggested. Read{" "}
          {small.map((variant) => `${variant.name} (${formatInteger(variant.runs)})`).join(", ")} as
          early figures.
        </Callout>
      ) : null}
      <Section
        title="Variants"
        description={
          <>
            {comparison.baseline
              ? `Compared with ${comparison.baseline.name}, ${comparison.baseline.reason === "named" ? "the variant named as the baseline" : "the variant with the most runs"}. `
              : ""}
            Each figure shows its 95% range below it.
            {clamped ? " Showing the last 30 days of this range." : ""}
            {comparison.truncated ? " Only the variants with the most runs are shown." : ""}
          </>
        }
      >
        <DataTable
          caption="Variants"
          columns={columns}
          rows={comparison.variants}
          rowKey={(row) => row.name}
        />
      </Section>
      {healthKinds.length > 0 ? (
        <Section
          title="Health signals"
          description="The share of each variant's runs that showed the signal. Lower is better."
        >
          <DataTable
            caption="Health signals by variant"
            columns={healthColumns}
            rows={comparison.variants}
            rowKey={(row) => row.name}
          />
        </Section>
      ) : null}
    </div>
  );
}

function SuggestionCallout({
  suggestion,
  variant,
  baseline,
}: {
  suggestion: CheaperSuggestion;
  variant: VariantMetrics;
  baseline: VariantMetrics;
}) {
  const scored = suggestion.qualityBasis.includes("scorer_pass_rate");
  return (
    <Callout
      tone="success"
      title={`${suggestion.variant} costs ${formatPercent(suggestion.savingsFraction)} less per successful run, with the same quality`}
    >
      {suggestion.variant} costs {formatCost(suggestion.costPerSuccessUsd)} per successful run
      against {formatCost(suggestion.baselineCostPerSuccessUsd)} for {suggestion.baseline}. Its
      error rate of {formatPercent(variant.errorRate?.value)} stays within {suggestion.baseline}
      &apos;s range ({rangeText(baseline.errorRate)})
      {scored && variant.scorerPassRate && baseline.scorerPassRate
        ? `, and its scorer pass rate of ${formatPercent(variant.scorerPassRate.value)} within ${suggestion.baseline}'s range (${rangeText(baseline.scorerPassRate)})`
        : ""}
      .
      {scored
        ? ""
        : " No task scorer covers these runs, so the error rate is the only quality check."}
    </Callout>
  );
}

function VariantName({ variant }: { variant: VariantMetrics }) {
  const descriptors = DESCRIPTORS_SHOWN.flatMap((key) => {
    const value = variant.attrs[key];
    return typeof value === "string" || typeof value === "number" ? [String(value)] : [];
  });
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium text-fg">{variant.name}</span>
        {variant.isBaseline ? <Badge tone="accent">Baseline</Badge> : null}
        {variant.belowMinimumSample ? <Badge tone="warning">Too few runs</Badge> : null}
      </span>
      {descriptors.length > 0 ? (
        <span className="truncate text-xs text-fg-subtle">{descriptors.join(" · ")}</span>
      ) : null}
    </span>
  );
}

function RateCell({ rate }: { rate: Rate | null }) {
  if (!rate) return <span className="text-fg-faint">—</span>;
  return <Figure value={formatPercent(rate.value)} sub={rangeText(rate)} />;
}

function EstimateCell({
  estimate,
  format,
}: {
  estimate: Estimate | null;
  format: (value: number) => string;
}) {
  if (!estimate) return <span className="text-fg-faint">—</span>;
  return (
    <Figure
      value={format(estimate.value)}
      sub={`${format(estimate.interval.low)}–${format(estimate.interval.high)}`}
    />
  );
}

function Figure({ value, sub }: { value: string; sub: string }) {
  return (
    <span className="flex flex-col items-end tabular-nums">
      <span className="text-fg">{value}</span>
      <span className="text-xs text-fg-subtle">{sub}</span>
    </span>
  );
}

/** Dollars to three significant figures under $1, so a per-run cost reads "$0.0124", not "$0.01". */
function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  if (Math.abs(usd) >= 1) return `$${usd.toFixed(2)}`;
  if (Math.abs(usd) < 0.0001) return "<$0.0001";
  return `$${Number(usd.toPrecision(3)).toString()}`;
}

function rangeText(rate: Rate | null): string {
  return rate ? `${formatPercent(rate.interval.low)}–${formatPercent(rate.interval.high)}` : "—";
}
