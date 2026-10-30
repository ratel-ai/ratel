"use client";

import { DataTable } from "@ratel/design-system/data-table";
import type { ReactNode } from "react";

export type TextColumn = {
  id: string;
  header: string;
  align?: "left" | "right";
  width?: string;
  hiddenBelow?: "sm" | "md" | "lg";
};

/**
 * A DataTable of rows already formatted on the server: a server page cannot hand the table its
 * cell functions, so it hands it strings keyed by column id.
 */
export function TextTable({
  caption,
  columns,
  rows,
  empty,
}: {
  caption: string;
  columns: readonly TextColumn[];
  rows: readonly ({ key: string } & Record<string, string>)[];
  empty?: ReactNode;
}) {
  return (
    <DataTable
      caption={caption}
      columns={columns.map((column) => ({
        ...column,
        cell: (row: Record<string, string>) => row[column.id],
      }))}
      rows={rows}
      rowKey={(row) => row.key}
      empty={empty}
    />
  );
}
