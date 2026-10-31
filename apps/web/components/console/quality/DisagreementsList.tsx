"use client";

import { Badge } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { ToolPin } from "@ratel/design-system/entity";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { stepIndex } from "@ratel/design-system/peek";
import { SquareArrowOutUpRight } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { formatTimestamp } from "@/lib/synthesis/traces/format";
import { relativeTimeLabel } from "@/lib/views/intents/adaptive-view";
import { DISAGREEMENT_LABEL, type DisagreementRow } from "@/lib/views/quality/experiments";
import { percent } from "@/lib/views/quality/model";
import { diffRows, RankingList } from "./RankingList";
import { TestSearch } from "./TestSearch";

/**
 * The open experiment's searches where the two variants disagreed. A row
 * opens the Panel with both rankings side by side: the selection inspector,
 * without leaving the list.
 */
export function DisagreementsList({
  projectId,
  rows,
  now,
}: {
  projectId: string;
  rows: readonly DisagreementRow[];
  now: string;
}) {
  const peek = usePeek();
  const [lastId, setLastId] = useState<string | null>(null);
  const at = useMemo(() => new Date(now), [now]);
  const open = rows.find((row) => row.id === peek.id) ?? null;
  const showing = open ?? rows.find((row) => row.id === lastId) ?? null;
  const openRow = (id: string) => {
    setLastId(id);
    peek.open(id);
  };
  const step = (direction: 1 | -1) => {
    const next = rows[stepIndex(open ? rows.indexOf(open) : -1, direction, rows.length)];
    if (next) openRow(next.id);
  };

  const columns: readonly Column<DisagreementRow>[] = [
    {
      id: "query",
      header: "Search",
      className: "w-full max-w-0 min-w-40",
      cell: (row) =>
        row.query ? (
          <span className="block truncate">{row.query}</span>
        ) : (
          <span className="text-fg-subtle">Query not recorded</span>
        ),
    },
    {
      id: "current",
      header: "Current picked",
      width: "20%",
      hiddenBelow: "sm",
      cell: (row) => <FirstPick name={row.current.items[0]?.name} />,
    },
    {
      id: "comparison",
      header: "Comparison picked",
      width: "20%",
      hiddenBelow: "sm",
      cell: (row) => <FirstPick name={row.comparison.items[0]?.name} />,
    },
    {
      id: "kind",
      header: "Difference",
      width: "15rem",
      className: "min-w-60 max-xl:hidden",
      headerClassName: "max-xl:hidden",
      cell: (row) => (
        <span className="whitespace-nowrap text-fg-muted">{DISAGREEMENT_LABEL[row.kind]}</span>
      ),
    },
    {
      id: "when",
      header: "When",
      align: "right",
      width: "6rem",
      hiddenBelow: "md",
      cell: (row) => (
        <time
          dateTime={row.occurredAt}
          title={formatTimestamp(row.occurredAt)}
          className="whitespace-nowrap text-fg-muted"
        >
          {relativeTimeLabel(new Date(row.occurredAt), at)}
        </time>
      ),
    },
  ];

  return (
    <>
      <DataTable
        caption="Searches where the two variants disagreed"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        selectedKey={open?.id ?? null}
        onRowOpen={(row) => openRow(row.id)}
      />
      <Panel
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) peek.close();
        }}
        title={showing?.query ?? "Query not recorded"}
        subtitle={
          showing
            ? `${DISAGREEMENT_LABEL[showing.kind]} · ${formatTimestamp(showing.occurredAt)}`
            : undefined
        }
        onPrevious={() => step(-1)}
        onNext={() => step(1)}
      >
        {showing ? <DisagreementDetail projectId={projectId} row={showing} /> : null}
      </Panel>
    </>
  );
}

/** The Panel body: both rankings, how much they share, and where to go next. */
export function DisagreementDetail({
  projectId,
  row,
}: {
  projectId: string;
  row: DisagreementRow;
}) {
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-ui">
        <dt className="text-fg-subtle">Difference</dt>
        <dd className="text-fg">{DISAGREEMENT_LABEL[row.kind]}</dd>
        <dt className="text-fg-subtle">Agreement</dt>
        <dd className="text-fg tabular-nums">
          {percent(row.agreement)}
          <span className="ml-2 text-xs text-fg-subtle">of results in both lists</span>
        </dd>
      </dl>
      <div className="flex flex-col gap-4">
        <RankingList
          title={`Current: ${row.current.arm}`}
          badge={<Badge>Shown to your agent</Badge>}
          rows={diffRows(row.current.items)}
        />
        <RankingList
          title={`Comparison: ${row.comparison.arm}`}
          rows={diffRows(row.comparison.items)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <TestSearch projectId={projectId} test={row.test} />
        {row.traceHref ? (
          <Link href={row.traceHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            <SquareArrowOutUpRight aria-hidden className="size-3.5" />
            Open trace
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function FirstPick({ name }: { name: string | undefined }) {
  if (!name) return <span className="text-fg-subtle">Nothing returned</span>;
  return <ToolPin name={name} />;
}
