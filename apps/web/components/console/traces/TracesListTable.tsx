"use client";

import { type Column, DataTable, type DataTableProps } from "@ratel/design-system/data-table";

/** Characters of an id the ID column shows; the full id is its tooltip. */
export const SHORT_ID_CHARS = 8;

/**
 * The one list layout of the Traces tabs with `cloud-trace-views-v3`
 * (RC-503, decision sessions-first): Sessions and Turns are the same table,
 * the ID column first, then the tab's own columns. A row opens its Panel.
 */
export function TracesListTable<T>({
  idOf,
  columns,
  ...table
}: Omit<DataTableProps<T>, "columns"> & {
  idOf: (row: T) => string;
  columns: readonly Column<T>[];
}) {
  return <DataTable {...table} columns={[idColumn(idOf), ...columns]} />;
}

/** The ID column: the first characters of the id in mono, the full id on hover. */
export function idColumn<T>(idOf: (row: T) => string): Column<T> {
  return {
    id: "id",
    header: "ID",
    width: "8.5rem",
    className: "whitespace-nowrap",
    cell: (row) => {
      const id = idOf(row);
      return (
        <span title={id} className="font-mono text-xs text-fg-muted" data-row-id={id}>
          {id.length > SHORT_ID_CHARS ? `${id.slice(0, SHORT_ID_CHARS)}…` : id}
        </span>
      );
    },
  };
}
