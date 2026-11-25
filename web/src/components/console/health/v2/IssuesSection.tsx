"use client";

import { Button } from "@ratel/design-system/button";
import { DataTable } from "@ratel/design-system/data-table";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { CircleCheck } from "lucide-react";
import { useState } from "react";
import { Calculating } from "@/components/console/health/v2/Calculating";
import {
  Dismissed,
  IssueAnchors,
  issueColumns,
  Locked,
  StillReading,
} from "@/components/console/health/v2/issue-list-parts";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import { useIssuePanel } from "@/components/console/health/v2/use-issue-panel";
import type { DismissedSignal } from "@/lib/readings/trace-signals/dismiss";
import type { EarlyProgress } from "@/lib/readings/trace-signals/signals/early-reading";
import { ISSUES_SHOWN, type IssueRow } from "@/lib/views/health/issue-rows";

/**
 * Issues, one list worst first, whatever found them: each row is the kind's
 * icon, its plain title, its status, the one number that matters and the
 * way forward ("Update description" on Quality › Descriptions, "Fix" on
 * Fixes, else "See turns"). The tools, the task, the sentences and the
 * example turns live in the row's Panel (`?peek=issue:<id>`); `j` and `k`
 * step through the rows while it is open. Five show until the reader asks
 * for the rest. Links from Fixes, the Overview and the map (`#signal-<id>`)
 * open the row they name.
 */

export interface IssuesSectionProps {
  projectId: string;
  rows: readonly IssueRow[];
  /** "9 issues across 17 tools, worst first." */
  line: string;
  /** The span the issues were read over when it is not the selected window: "last 31 days". */
  windowLabel: string | null;
  /** False on a plan without example turns. */
  examplesAllowed: boolean;
  /** Issues the plan hides. */
  lockedCount: number;
  /** Where a plan can be picked; null when billing is off. */
  upgradeHref: string | null;
  /** The plan that shows every issue and its turns ("Plus"); null names the limits instead. */
  lockedPlan?: string | null;
  /** Slow tools hidden as slow by design, each with "Show again". */
  dismissed: readonly DismissedSignal[];
  /** The reading is early (RC-225): the list is as of now, more may come. */
  calculating?: { progress: EarlyProgress | null } | null;
}

export function IssuesSection({
  projectId,
  rows,
  line,
  windowLabel,
  examplesAllowed,
  lockedCount,
  upgradeHref,
  lockedPlan = null,
  dismissed,
  calculating = null,
}: IssuesSectionProps) {
  const [showAll, setShowAll] = useState(false);
  const { open, openRow, openIndex, panel } = useIssuePanel({
    projectId,
    rows,
    examplesAllowed,
    upgradeHref,
    lockedPlan,
  });
  const expanded = showAll || openIndex >= ISSUES_SHOWN;
  const visible = expanded ? rows : rows.slice(0, ISSUES_SHOWN);
  const hidden = rows.slice(visible.length);

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
        {rows.length === 0 && calculating ? (
          <StillReading progress={calculating.progress} empty />
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-line">
            <EmptyState
              icon={CircleCheck}
              title="No issues"
              description="Nothing stands out in the latest reading."
            />
          </div>
        ) : (
          <>
            <DataTable
              caption={
                rows.some((row) => row.points !== undefined)
                  ? "Issues, most points first"
                  : "Issues, worst first"
              }
              columns={columns}
              rows={visible}
              rowKey={(row) => row.key}
              selectedKey={openRow?.key ?? null}
              onRowOpen={(row) => open(row)}
            />
            {/* Every hidden row keeps its links' targets, so `#signal-<id>` always finds one. */}
            {hidden.length > 0 ? <IssueAnchors rows={hidden} /> : null}
            {rows.length > ISSUES_SHOWN ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                aria-expanded={expanded}
                onClick={() => setShowAll(!expanded)}
                data-show-all-issues=""
              >
                {expanded
                  ? `Show only the worst ${ISSUES_SHOWN}`
                  : `Show all ${rows.length} issues`}
              </Button>
            ) : null}
            {calculating ? <StillReading progress={calculating.progress} /> : null}
          </>
        )}
        {lockedCount > 0 ? (
          <Locked count={lockedCount} upgradeHref={upgradeHref} plan={lockedPlan} />
        ) : null}
        {dismissed.length > 0 ? <Dismissed projectId={projectId} dismissed={dismissed} /> : null}
      </div>
      {panel}
    </Section>
  );
}
