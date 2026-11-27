"use client";

import { Badge } from "@ratel/design-system/badge";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { FilterBar, SearchInput } from "@ratel/design-system/filter-bar";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { Database } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { PickerOptions } from "@/lib/views/evals/adapters/turn-picker";
import { type DatasetListRow, filterDatasets, shortText } from "@/lib/views/evals/dataset-pages";
import { NewDatasetDialog } from "./NewDatasetDialog";

/** The Datasets page: one row a dataset, a filter, and "New dataset". */
export function DatasetsList({
  projectId,
  rows,
  options,
  canEdit,
  now,
}: {
  projectId: string;
  rows: readonly DatasetListRow[];
  options: PickerOptions;
  canEdit: boolean;
  /** ISO time the page was rendered, so relative times agree on server and client. */
  now: string;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const shown = filterDatasets(rows, filter);
  const columns: Column<DatasetListRow>[] = [
    {
      id: "name",
      header: "Name",
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <Link href={row.href} className="truncate font-medium text-fg hover:underline">
            {row.name}
          </Link>
          {row.description ? (
            <span className="truncate text-xs text-fg-subtle">{row.description}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: "kind",
      header: "Kind",
      width: "10rem",
      cell: (row) => (
        <Badge tone={row.kind === "fixed" ? "neutral" : "info"}>{row.kindLabel}</Badge>
      ),
    },
    {
      id: "cases",
      header: "Cases or query",
      width: "22rem",
      hiddenBelow: "sm",
      cell: (row) =>
        row.kind === "rql" ? (
          <code className="block truncate font-mono text-xs text-fg-muted" title={row.cases}>
            {shortText(row.cases, 80)}
          </code>
        ) : (
          <span className={row.rowCount === null ? "text-fg-muted" : "tabular-nums text-fg"}>
            {row.cases}
          </span>
        ),
    },
    {
      id: "updated",
      header: "Updated",
      width: "8rem",
      hiddenBelow: "md",
      cell: (row) => (
        <span className="text-fg-muted" title={row.updatedAt}>
          {formatRelativeTime(row.updatedAt, now)}
        </span>
      ),
    },
    {
      id: "used",
      header: "Used by",
      width: "14rem",
      hiddenBelow: "lg",
      cell: (row) =>
        row.usedBy.length === 0 ? (
          <span className="text-fg-faint">No eval</span>
        ) : (
          <span className="flex min-w-0 flex-wrap gap-x-2">
            {row.usedBy.map((used) => (
              <Link
                key={used.evalId}
                href={used.href}
                className="truncate text-fg-muted hover:text-fg hover:underline"
              >
                {used.name}
              </Link>
            ))}
          </span>
        ),
    },
  ];
  return (
    <Page>
      <PageHeader
        title="Datasets"
        description="The inputs of your evals: saved rows, or a query that a run resolves."
        actions={
          canEdit ? <NewDatasetDialog projectId={projectId} options={options} now={now} /> : null
        }
      />
      <PageBody>
        <FilterBar
          search={
            <SearchInput
              value={filter}
              onValueChange={setFilter}
              placeholder="Filter datasets"
              label="Filter datasets"
            />
          }
        />
        <DataTable
          caption="Datasets"
          columns={columns}
          rows={shown}
          rowKey={(row) => row.datasetId}
          onRowOpen={(row) => router.push(row.href)}
          empty={
            rows.length === 0 ? (
              <EmptyState
                icon={Database}
                title="No dataset yet"
                description="New dataset makes one from traces you choose, or from a query. Save as eval case on a trace adds a row."
              />
            ) : (
              <EmptyState
                icon={Database}
                title="No dataset matches"
                description={`No name, description, kind or query has "${filter.trim()}".`}
              />
            )
          }
        />
      </PageBody>
    </Page>
  );
}
