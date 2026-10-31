"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { Tooltip } from "@ratel/design-system/tooltip";
import { ArrowUpRight, CircleCheck, PenLine, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { restoreSignalAction } from "@/app/(console)/project/[projectId]/health/signal-actions";
import { SIGNAL_OPEN_EVENT, signalAnchorFromHash } from "@/components/console/health/anchors";
import { SIGNAL_KIND_ICONS } from "@/components/console/health/kinds";
import { IssueDetail } from "@/components/console/health/v2/IssueDetail";
import type { ExamplesCache } from "@/components/console/health/v2/IssueExamples";
import {
  ISSUE_TONE_LABEL,
  ISSUES_SHOWN,
  type IssueRow,
  type IssueTone,
  issuePeek,
  peekedIssue,
  rowOfIssue,
} from "@/components/console/health/v2/issue-rows";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import type { DismissedSignal } from "@/lib/readings/trace-signals/dismiss";
import { DESCRIPTION_FIX_LABEL } from "@/lib/views/health/summary/fix-links";

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

const TONE: Readonly<Record<IssueTone, "danger" | "warning" | "neutral">> = {
  fix_now: "danger",
  watch: "warning",
  early: "neutral",
};
const SIGNAL_PREFIX = "signal-";

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
  /** Slow tools hidden as slow by design, each with "Show again". */
  dismissed: readonly DismissedSignal[];
}

export function IssuesSection({
  projectId,
  rows,
  line,
  windowLabel,
  examplesAllowed,
  lockedCount,
  upgradeHref,
  dismissed,
}: IssuesSectionProps) {
  const peek = usePeek();
  const openPeek = peek.open;
  const openId = peekedIssue(peek.id);
  const openRow = rowOfIssue(rows, openId);
  const openIndex = openRow ? rows.indexOf(openRow) : -1;
  const [showAll, setShowAll] = useState(false);
  const [fromTurns, setFromTurns] = useState<string | null>(null);
  // Keep the last row's body, on the member it was open on, while the panel animates out.
  const [shownRow, setShownRow] = useState<IssueRow | null>(openRow);
  const [shownId, setShownId] = useState<string | null>(openId);
  if (openRow && openRow !== shownRow) setShownRow(openRow);
  if (openId && openRow && openId !== shownId) setShownId(openId);
  // One cache for the page view: reopening an issue does not read its turns again.
  const [cache] = useState<ExamplesCache>(() => new Map());
  const expanded = showAll || openIndex >= ISSUES_SHOWN;
  const visible = expanded ? rows : rows.slice(0, ISSUES_SHOWN);
  const hidden = rows.slice(visible.length);

  // A link that names one issue (`#signal-<id>`): open its row, on the member it names.
  useEffect(() => {
    const follow = (anchor: string | null) => {
      if (!anchor?.startsWith(SIGNAL_PREFIX)) return;
      const id = anchor.slice(SIGNAL_PREFIX.length);
      if (!rowOfIssue(rows, id)) return;
      openPeek(issuePeek(id));
    };
    const onHash = () => follow(signalAnchorFromHash(window.location.hash));
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      follow(typeof detail === "string" ? detail : null);
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    window.addEventListener(SIGNAL_OPEN_EVENT, onRequest);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener(SIGNAL_OPEN_EVENT, onRequest);
    };
  }, [rows, openPeek]);

  const open = (row: IssueRow, turns = false) => {
    setFromTurns(turns ? row.key : null);
    peek.open(row.peek);
  };
  const step = (by: 1 | -1) => {
    const next = rows[Math.min(rows.length - 1, Math.max(0, openIndex + by))];
    if (next && next !== openRow) open(next);
  };

  const columns: readonly Column<IssueRow>[] = [
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
    {
      id: "measure",
      header: <span className="sr-only">Measure</span>,
      align: "right",
      cell: (row) => <FigureCell row={row} />,
    },
    {
      id: "action",
      header: <span className="sr-only">Next step</span>,
      cell: (row) => <ActionCell row={row} onTurns={() => open(row, true)} />,
    },
  ];

  return (
    <Section
      title={<NounTitle noun="issue">Issues</NounTitle>}
      description={
        <>
          {line}
          {windowLabel ? (
            <span className="text-fg-subtle"> Read over the {windowLabel}.</span>
          ) : null}
        </>
      }
    >
      <div data-health-issues={rows.length}>
        {rows.length === 0 ? (
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
              caption="Issues, worst first"
              columns={columns}
              rows={visible}
              rowKey={(row) => row.key}
              selectedKey={openRow?.key ?? null}
              onRowOpen={(row) => open(row)}
            />
            {/* Every hidden row keeps its links' targets, so `#signal-<id>` always finds one. */}
            {hidden.length > 0 ? (
              <div className="sr-only">
                {hidden
                  .flatMap((row) => row.anchors)
                  .map((anchor) => (
                    <span key={anchor} id={anchor} />
                  ))}
              </div>
            ) : null}
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
          </>
        )}
        {lockedCount > 0 ? <Locked count={lockedCount} upgradeHref={upgradeHref} /> : null}
        {dismissed.length > 0 ? <Dismissed projectId={projectId} dismissed={dismissed} /> : null}
      </div>
      <Panel
        open={openRow !== null}
        onOpenChange={(next) => {
          if (!next) peek.close();
        }}
        title={shownRow?.title ?? "Issue"}
        subtitle={
          shownRow
            ? `${ISSUE_TONE_LABEL[shownRow.tone]} · ${shownRow.figure.display} ${shownRow.figure.caption}`
            : undefined
        }
        onPrevious={openIndex > 0 ? () => step(-1) : undefined}
        onNext={openIndex >= 0 && openIndex < rows.length - 1 ? () => step(1) : undefined}
      >
        {shownRow ? (
          <IssueDetail
            key={`${shownRow.key}:${shownId ?? ""}`}
            projectId={projectId}
            row={shownRow}
            initialMemberId={shownId}
            examplesAllowed={examplesAllowed}
            upgradeHref={upgradeHref}
            focusExamples={fromTurns === shownRow.key}
            cache={cache}
          />
        ) : null}
      </Panel>
    </Section>
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
        {/* The status column folds away on a phone; the word moves here. */}
        <StatusDot
          tone={TONE[row.tone]}
          label={ISSUE_TONE_LABEL[row.tone]}
          className="text-xs whitespace-nowrap md:hidden"
        />
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
 * What the limits hide, as one quiet line; the map scrolls here when it names a hidden issue.
 * Owned (ADR-0030): no plan to name; `upgradeHref` is kept for the call sites and is null here.
 */
function Locked({ count, upgradeHref }: { count: number; upgradeHref: string | null }) {
  return (
    <p
      data-signals-locked={count}
      className="mt-3 flex flex-wrap items-center gap-x-2 text-ui text-fg-muted"
    >
      <span>
        {count.toLocaleString("en-US")} more {count === 1 ? "issue" : "issues"} outside this
        project&apos;s limits.
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
function Dismissed({
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
