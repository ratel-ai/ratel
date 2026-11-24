"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import type { Column } from "@ratel/design-system/data-table";
import { DotLoader } from "@ratel/design-system/dot-matrix";
import { Skeleton } from "@ratel/design-system/states";
import { Tooltip } from "@ratel/design-system/tooltip";
import { ArrowUpRight, PenLine, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { restoreSignalAction } from "@/app/(console)/project/[projectId]/health/signal-actions";
import { SIGNAL_KIND_ICONS } from "@/components/console/health/kinds";
import { ReadProgress } from "@/components/console/health/v2/Calculating";
import type { DismissedSignal } from "@/lib/readings/trace-signals/dismiss";
import type { EarlyProgress } from "@/lib/readings/trace-signals/signals/early-reading";
import { ISSUE_TONE_LABEL, type IssueRow, type IssueTone } from "@/lib/views/health/issue-rows";
import { DESCRIPTION_FIX_LABEL } from "@/lib/views/health/summary/fix-links";

/** What every list of issues draws: its columns, and the lines under it. */

const TONE: Readonly<Record<IssueTone, "danger" | "warning" | "neutral">> = {
  fix_now: "danger",
  watch: "warning",
  early: "neutral",
};

/** The columns of an issue list; "If fixed" shows when the rows carry points. */
export function issueColumns(
  rows: readonly IssueRow[],
  onTurns: (row: IssueRow) => void,
): readonly Column<IssueRow>[] {
  return [
    {
      id: "issue",
      header: "Issue",
      className: "w-full max-w-0 min-w-32",
      cell: (row) => <IssueCell row={row} />,
    },
    {
      id: "status",
      header: "Status",
      width: "7rem",
      className: "max-md:hidden",
      headerClassName: "max-md:hidden",
      cell: (row) => (
        <StatusDot
          tone={TONE[row.tone]}
          label={ISSUE_TONE_LABEL[row.tone]}
          className="whitespace-nowrap"
        />
      ),
    },
    ...(rows.some((row) => row.points !== undefined)
      ? [
          {
            id: "points",
            header: "If fixed",
            width: "5.5rem",
            align: "right" as const,
            className: "max-sm:hidden",
            headerClassName: "max-sm:hidden",
            cell: (row: IssueRow) => <PointsCell points={row.points} />,
          },
        ]
      : []),
    {
      id: "measure",
      header: <span className="sr-only">Measure</span>,
      align: "right",
      cell: (row) => <FigureCell row={row} />,
    },
    {
      id: "action",
      header: <span className="sr-only">Next step</span>,
      cell: (row) => <ActionCell row={row} onTurns={() => onTurns(row)} />,
    },
  ];
}

/** The link targets of rows that are not on screen, so `#signal-<id>` always finds one. */
export function IssueAnchors({ rows }: { rows: readonly IssueRow[] }) {
  return (
    <div className="sr-only">
      {rows
        .flatMap((row) => row.anchors)
        .map((anchor) => (
          <span key={anchor} id={anchor} />
        ))}
    </div>
  );
}

const LINK =
  "rounded-sm outline-none hover:text-fg hover:underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-focus";

/** The kind's icon and the plain title; on a phone the status word moves under it. Ids only in attributes. */
function IssueCell({ row }: { row: IssueRow }) {
  const [anchor, ...others] = row.anchors;
  const Icon = SIGNAL_KIND_ICONS[row.kind];
  return (
    <span
      id={anchor}
      className="flex min-w-0 scroll-mt-24 items-center gap-2.5 py-1.5"
      data-issue-row={row.memberIds[0]}
      data-issue-kind={row.kind}
    >
      {others.map((other) => (
        <span key={other} id={other} className="sr-only" />
      ))}
      <Icon
        aria-hidden
        strokeWidth={1.5}
        className="size-4 shrink-0 text-fg-muted"
        data-issue-icon={row.kind}
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-fg">{row.title}</span>
        {/* The status and points columns fold away on a phone; they move here. */}
        <span className="flex items-center gap-2 md:hidden">
          <StatusDot
            tone={TONE[row.tone]}
            label={ISSUE_TONE_LABEL[row.tone]}
            className="text-xs whitespace-nowrap"
          />
          {row.points !== undefined && row.points >= 1 ? (
            <span className="text-xs text-fg-subtle tabular-nums sm:hidden">
              +{row.points}&nbsp;pts
            </span>
          ) : null}
        </span>
      </span>
    </span>
  );
}

/** The one number; what it counts is a hover away, and read aloud with it. */
function FigureCell({ row }: { row: IssueRow }) {
  return (
    <Tooltip content={row.figure.caption}>
      <span className="font-medium whitespace-nowrap text-fg tabular-nums">
        {row.figure.display}
        <span className="sr-only"> {row.figure.caption}</span>
      </span>
    </Tooltip>
  );
}

function ActionCell({ row, onTurns }: { row: IssueRow; onTurns: () => void }) {
  const action = row.action;
  if (action.kind === "description" || action.kind === "fix") {
    const fix = row.fixes.find((each) => each.href === action.href);
    const description = action.kind === "description";
    return (
      <Link
        href={action.href}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
        data-issue-action={action.kind}
      >
        {description ? <PenLine aria-hidden /> : null}
        {description ? DESCRIPTION_FIX_LABEL : "Fix"}
        {fix ? <span className="sr-only">: {fix.title}</span> : null}
        {description ? null : <ArrowUpRight aria-hidden />}
      </Link>
    );
  }
  return (
    <Button variant="ghost" size="sm" onClick={onTurns} data-issue-action={action.kind}>
      {action.kind === "turns" ? "See turns" : "Details"}
      <span className="sr-only">: {row.title}</span>
    </Button>
  );
}

/**
 * What the plan hides, as one quiet line; the map scrolls here when it names a hidden issue.
 * Owned (ADR-0004): the plan is named only with an edition's plans; otherwise the limits are.
 */
export function Locked({
  count,
  upgradeHref,
  plan,
}: {
  count: number;
  upgradeHref: string | null;
  plan: string | null;
}) {
  return (
    <p
      data-signals-locked={count}
      className="mt-3 flex flex-wrap items-center gap-x-2 text-ui text-fg-muted"
    >
      <span>
        {count.toLocaleString("en-US")} more {count === 1 ? "issue" : "issues"}{" "}
        {plan ? `on ${plan}.` : "outside this project's limits."}
      </span>
      {upgradeHref ? (
        <Link href={upgradeHref} className={cn(LINK, "text-fg")}>
          See plans
        </Link>
      ) : null}
    </p>
  );
}

/** Slow tools hidden as slow by design, each with "Show again". */
export function Dismissed({
  projectId,
  dismissed,
}: {
  projectId: string;
  dismissed: readonly DismissedSignal[];
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div
      data-signals-dismissed={dismissed.length}
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-ui text-fg-muted"
    >
      <span>Hidden as slow by design:</span>
      {dismissed.map((item) => (
        <span key={item.id} className="inline-flex items-center gap-1.5">
          <span className="font-mono text-xs text-fg">{item.label}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setError(null);
                const result = await restoreSignalAction(projectId, item.id);
                if (!result.ok) setError(result.message);
              })
            }
          >
            <RotateCcw aria-hidden />
            Show again<span className="sr-only">: {item.label}</span>
          </Button>
        </span>
      ))}
      {error ? (
        <span role="alert" className="text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** What fixing the row wins back on the Health score; under a point reads as a dash. */
function PointsCell({ points }: { points: number | undefined }) {
  if (points === undefined) return null;
  if (points < 1)
    return (
      <span className="text-ui text-fg-faint tabular-nums" title="Less than a point">
        -
      </span>
    );
  return (
    <span
      className="text-ui whitespace-nowrap text-fg-muted tabular-nums"
      data-issue-points={points}
    >
      +{points}&nbsp;pts
    </span>
  );
}

/**
 * Under an early reading's list (RC-225): faint rows where more issues may
 * land, the loader that means work is in progress, and how far the reading
 * has got. The list above is as of now.
 */
export function StillReading({
  progress,
  empty = false,
}: {
  progress: EarlyProgress | null;
  empty?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3",
        empty ? "rounded-lg border border-line p-4" : "mt-3 border-t border-line pt-4",
      )}
      data-health-still-reading=""
    >
      <div aria-hidden className="flex flex-col gap-2 px-4 opacity-60">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-4 w-1/4" />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4">
        <span className="inline-flex items-center gap-2 text-ui text-fg-muted">
          <DotLoader size="sm" label="Reading the rest of your runs" />
          {empty
            ? "Nothing stands out yet. Still reading the rest of your runs."
            : "More issues may appear as we read the rest."}
        </span>
        {progress ? <ReadProgress progress={progress} /> : null}
      </div>
    </div>
  );
}
