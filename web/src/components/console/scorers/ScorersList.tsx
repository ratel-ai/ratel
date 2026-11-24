"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";
import { scorersHref } from "@/lib/views/scorers/paths";
import { EnabledSwitch, KindBadge, type ScorerItem, summaryValue } from "./parts";

/** The project's scorers, or the way to the first one. */
export function ScorersList({
  projectId,
  scorers,
}: {
  projectId: string;
  scorers: readonly ScorerItem[];
}) {
  const router = useRouter();
  const root = scorersHref(projectId);
  const create = (
    <Link href={`${root}/new`} className={buttonVariants({ variant: "primary" })}>
      Create scorer
    </Link>
  );
  const columns: Column<ScorerItem>[] = [
    {
      id: "name",
      header: "Scorer",
      className: "w-full max-w-0 min-w-48",
      cell: (row) => (
        <span className="flex min-w-0 items-baseline gap-2">
          <Link href={`${root}/${row.id}`} className="shrink-0 text-fg hover:underline">
            {row.name}
          </Link>
          <span className="min-w-0 truncate text-xs text-fg-subtle">{row.summary}</span>
        </span>
      ),
    },
    {
      id: "kind",
      header: "Kind",
      width: "6rem",
      hiddenBelow: "sm",
      cell: (row) => <KindBadge kind={row.kind} />,
    },
    {
      id: "sample",
      header: "Sample",
      align: "right",
      width: "5rem",
      hiddenBelow: "md",
      cell: (row) => `${row.sampleRate}%`,
    },
    {
      id: "scored",
      header: "Scored, 7 days",
      align: "right",
      width: "8rem",
      hiddenBelow: "md",
      cell: (row) => formatInteger(row.week?.scored ?? 0),
    },
    {
      id: "result",
      header: "Result, 7 days",
      align: "right",
      width: "8rem",
      cell: (row) => summaryValue(row),
    },
    {
      id: "enabled",
      header: "On",
      width: "4rem",
      cell: (row) => (
        // The row opens the scorer; the switch must not.
        // biome-ignore lint/a11y/noStaticElementInteractions: it only stops the row's click.
        // biome-ignore lint/a11y/useKeyWithClickEvents: it only stops the row's click.
        <span onClick={(event) => event.stopPropagation()}>
          <EnabledSwitch
            projectId={projectId}
            scorer={row}
            label={<span className="sr-only">{`${row.name} is on`}</span>}
          />
        </span>
      ),
    },
  ];
  return (
    <Page>
      <PageHeader
        title="Scorers"
        description="Each scorer gives every matching trace one result."
        actions={scorers.length > 0 ? create : undefined}
      />
      <PageBody wide>
        {scorers.length === 0 ? (
          <EmptyState
            emblem
            title="No scorers yet"
            description="A scorer checks each new trace, or a sample, and keeps one result per trace."
            action={create}
          />
        ) : (
          <DataTable
            caption="Scorers"
            columns={columns}
            rows={scorers}
            rowKey={(row) => row.id}
            onRowOpen={(row) => router.push(`${root}/${row.id}`)}
          />
        )}
      </PageBody>
    </Page>
  );
}
