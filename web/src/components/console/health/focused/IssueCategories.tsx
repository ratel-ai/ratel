"use client";

import { cn } from "@ratel/design-system/cn";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { DotMeter } from "@ratel/design-system/dot-matrix";
import { Section } from "@ratel/design-system/section";
import { ChevronRight, CircleCheck } from "lucide-react";
import { useId, useState } from "react";
import { Calculating } from "@/components/console/health/v2/Calculating";
import type { IssuesSectionProps } from "@/components/console/health/v2/IssuesSection";
import {
  Dismissed,
  issueColumns,
  Locked,
  StillReading,
} from "@/components/console/health/v2/issue-list-parts";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import { useIssuePanel } from "@/components/console/health/v2/use-issue-panel";
import type { IssueHarm } from "@/lib/readings/trace-signals/health-score";
import type { CategoryRate, IssueCategory } from "@/lib/views/health/issue-categories";
import type { IssueRow } from "@/lib/views/health/issue-rows";

/**
 * The issues under the score's four categories, worst first. A category that costs points is
 * open; a healthy one is a quiet row with a check. Each issue opens in the Panel
 * (`?peek=issue:<id>`), where `j` and `k` step across the categories; opening one, by a click, a
 * key or a `#signal-<id>` link, opens its category.
 */
export function IssueCategories({
  projectId,
  categories,
  complete,
  line,
  windowLabel,
  examplesAllowed,
  lockedCount,
  upgradeHref,
  lockedPlan = null,
  dismissed,
  calculating = null,
}: Omit<IssuesSectionProps, "rows"> & {
  categories: readonly IssueCategory[];
  /** Every issue that counts is known, so an empty category is a healthy one. */
  complete: boolean;
}) {
  const rows = categories.flatMap((category) => category.rows);
  const { open, openRow, panel } = useIssuePanel({
    projectId,
    rows,
    examplesAllowed,
    upgradeHref,
    lockedPlan,
  });
  const [toggled, setToggled] = useState<Partial<Record<IssueHarm, boolean>>>({});
  const [shownRow, setShownRow] = useState<IssueRow | null>(null);
  if (openRow !== shownRow) {
    setShownRow(openRow);
    const level = categories.find((category) =>
      category.rows.some((row) => row.key === openRow?.key),
    )?.level;
    if (level) setToggled((previous) => ({ ...previous, [level]: true }));
  }
  const columns = issueColumns(rows, (row) => open(row, true));
  return (
    <Section
      title={<NounTitle noun="issue">Issues</NounTitle>}
      description={
        <>
          {line}
          {windowLabel ? (
            <span className="text-fg-subtle"> Read over the {windowLabel}.</span>
          ) : null}
          {calculating ? (
            <Calculating progress={calculating.progress} className="ml-2 align-middle" />
          ) : null}
        </>
      }
    >
      <div data-health-issues={rows.length}>
        <div className="divide-y divide-line rounded-lg border border-line">
          {categories.map((category) => (
            <Category
              key={category.level}
              category={category}
              complete={complete}
              columns={columns}
              selectedKey={openRow?.key ?? null}
              open={toggled[category.level] ?? startsOpen(category)}
              onToggle={(next) =>
                setToggled((previous) => ({ ...previous, [category.level]: next }))
              }
              onRowOpen={open}
            />
          ))}
        </div>
        {calculating ? (
          <StillReading progress={calculating.progress} empty={rows.length === 0} />
        ) : null}
        {lockedCount > 0 ? (
          <Locked count={lockedCount} upgradeHref={upgradeHref} plan={lockedPlan} />
        ) : null}
        {dismissed.length > 0 ? <Dismissed projectId={projectId} dismissed={dismissed} /> : null}
      </div>
      {panel}
    </Section>
  );
}

/** What costs points is open; without a score, what has an issue. */
function startsOpen({ lost, issues }: IssueCategory): boolean {
  return lost === null ? issues > 0 : lost > 0;
}

function Category({
  category,
  complete,
  columns,
  selectedKey,
  open,
  onToggle,
  onRowOpen,
}: {
  category: IssueCategory;
  complete: boolean;
  columns: readonly Column<IssueRow>[];
  selectedKey: string | null;
  open: boolean;
  onToggle: (open: boolean) => void;
  onRowOpen: (row: IssueRow) => void;
}) {
  const id = useId();
  const healthy = category.healthy && complete;
  return (
    <section
      aria-labelledby={`${id}-title`}
      data-health-category={category.level}
      data-health-category-lost={category.lost ?? undefined}
    >
      <h3>
        <button
          type="button"
          id={`${id}-title`}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => onToggle(!open)}
          className="flex min-h-12 w-full items-center gap-2.5 rounded-md px-4 py-2 text-left outline-none transition-colors duration-120 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-fg-subtle transition-transform duration-160 ease-enter motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <span
            className={cn(
              "min-w-0 flex-1 text-sm font-semibold",
              category.healthy ? "text-fg-muted" : "text-fg",
            )}
          >
            {category.label}
          </span>
          {category.healthy ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-ui text-fg-subtle">
              {healthy ? (
                <CircleCheck aria-hidden strokeWidth={1.5} className="size-4 text-success" />
              ) : null}
              {healthy ? "Healthy" : "Nothing to show"}
            </span>
          ) : (
            <span className="flex shrink-0 items-center gap-3 text-ui text-fg-muted tabular-nums">
              <span>{countLine(category)}</span>
              {category.lost ? (
                <span className="font-medium text-fg">
                  <span aria-hidden>{"\u2212"}</span>
                  <span className="sr-only">minus </span>
                  {category.lost}&nbsp;{category.lost === 1 ? "pt" : "pts"}
                </span>
              ) : null}
            </span>
          )}
        </button>
      </h3>
      {/* Closed rows stay in the page, so a `#signal-<id>` link still finds its target. */}
      <div id={`${id}-body`} hidden={!open}>
        <div className="flex flex-col gap-4 px-4 pt-1 pb-4">
          {category.rates.length > 0 ? <Rates rates={category.rates} /> : null}
          {category.rows.length > 0 ? (
            <DataTable
              caption={`${category.label}: issues, ${category.lost === null ? "worst" : "most points"} first`}
              columns={columns}
              rows={category.rows}
              rowKey={(row) => row.key}
              selectedKey={selectedKey}
              onRowOpen={onRowOpen}
            />
          ) : (
            <p className="text-ui text-fg-subtle">No issues here in the latest reading.</p>
          )}
        </div>
      </div>
    </section>
  );
}

/** "3 issues", "1 issue, 2 too early to call". */
function countLine({ issues, early }: IssueCategory): string {
  const count = `${issues.toLocaleString("en-US")} ${issues === 1 ? "issue" : "issues"}`;
  const later = `${early.toLocaleString("en-US")} too early to call`;
  if (early === 0) return count;
  return issues === 0 ? later : `${count}, ${later}`;
}

/** The measured rates of the category: how often it went well. */
function Rates({ rates }: { rates: readonly CategoryRate[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
      {rates.map((rate) => {
        const percent = Math.round(rate.good * 100);
        return (
          <div
            key={rate.pillar}
            data-health-rate={rate.pillar}
            className="flex min-w-0 flex-col gap-1"
          >
            <dt className="truncate text-xs text-fg-subtle">{rate.label}</dt>
            <dd className="flex items-center gap-2">
              <span className="text-sm font-semibold text-fg tabular-nums">{percent}%</span>
              <DotMeter
                value={rate.good}
                cells={10}
                tone="neutral"
                label={`${rate.label}: ${percent}%`}
              />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
