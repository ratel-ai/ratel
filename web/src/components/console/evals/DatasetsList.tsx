"use client";

import { Badge } from "@ratel/design-system/badge";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { FilterBar, SearchInput } from "@ratel/design-system/filter-bar";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { Table2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import {
  type DatasetListRow,
  type DatasetsPageModel,
  filterDatasets,
} from "@/lib/views/evals/datasets-page";
import { datasetHref } from "@/lib/views/evals/paths";
import { NewDatasetDialog } from "./NewDatasetDialog";

/** The Datasets page: one row a dataset, a filter, and "New dataset". */
export function DatasetsList({
  model,
  tasks,
  canEdit,
  now,
}: {
  model: DatasetsPageModel;
  tasks: ReadonlyArray<{ id: string; name: string }>;
  canEdit: boolean;
  /** ISO time the page was rendered, so relative times agree on server and client. */
  now: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const rows = filterDatasets(model.rows, search);
  const href = (row: DatasetListRow) => datasetHref(model.projectId, row.datasetId);
  const columns: Column<DatasetListRow>[] = [
    {
      id: "name",
      header: "Name",
      cell: (row) => (
        <Link href={href(row)} className="font-medium text-fg hover:underline">
          {row.name}
        </Link>
      ),
    },
    {
      id: "kind",
      header: "Kind",
      width: "10rem",
      cell: (row) => <Badge tone="neutral">{row.kindLabel}</Badge>,
    },
    {
      id: "size",
      header: "Cases or query",
      cell: (row) =>
        row.rql ? (
          <code
            className="block max-w-[28rem] truncate font-mono text-xs text-fg-muted"
            title={row.size}
          >
            {row.size}
          </code>
        ) : (
          <span className="text-fg-muted">{row.size}</span>
        ),
    },
    {
      id: "updated",
      header: "Updated",
      width: "8rem",
      hiddenBelow: "sm",
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
      hiddenBelow: "md",
      cell: (row) =>
        row.usedBy.length === 0 ? (
          <span className="text-fg-faint">No eval</span>
        ) : (
          <span className="flex flex-wrap gap-x-2 gap-y-0.5">
            {row.usedBy.map((one) => (
              <Link
                key={one.evalId}
                href={one.href}
                className="text-fg-muted hover:text-fg hover:underline"
              >
                {one.name}
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
        description="The inputs that your evals run: rows that you keep, or a query of your traces."
        actions={canEdit ? <NewDatasetDialog projectId={model.projectId} tasks={tasks} /> : null}
      />
      <PageBody wide>
        <FilterBar
          search={
            <SearchInput
              value={search}
              onValueChange={setSearch}
              placeholder="Filter datasets"
              label="Filter datasets"
            />
          }
        />
        <DataTable
          caption="Datasets"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.datasetId}
          onRowOpen={(row) => router.push(href(row))}
          empty={
            model.rows.length === 0 ? (
              <EmptyState
                icon={Table2}
                title="No dataset yet"
                description={`A dataset holds the inputs of an eval. Save a trace as an eval case${canEdit ? ", or use New dataset" : ""}.`}
              />
            ) : (
              <EmptyState
                icon={Table2}
                title="No dataset matches"
                description="Change the filter."
              />
            )
          }
        />
      </PageBody>
    </Page>
  );
}
