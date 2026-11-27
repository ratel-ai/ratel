import { DataTable } from "@ratel/design-system/data-table";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { Table2 } from "lucide-react";
import type { ToolSuccess } from "../../shell/state";
import { cellText, isNumericType, readTable } from "./table";

type Row = { index: number; values: unknown[] };

/** The rows of an RQL query, with one column for each selected value and its type. */
export function TableBody({ result }: { result: ToolSuccess }) {
  const table = readTable(result);
  if (!table)
    return (
      <Callout tone="warning" title="Nothing to show">
        The tool answered without the columns and rows this view expects.
      </Callout>
    );
  const rows: Row[] = table.rows.map((values, index) => ({ index, values }));
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-sm text-fg-muted">{table.summary}</p>
      {table.truncated ? (
        <Callout tone="info" title="The first rows only">
          The query had more rows than its limit. Add a LIMIT, or narrow the WHERE.
        </Callout>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          icon={Table2}
          title="No row"
          description="No row matched in this window. Widen the window, or change the WHERE."
        />
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <DataTable<Row>
            caption="The rows of the RQL query"
            density="compact"
            rows={rows}
            rowKey={({ index }) => String(index)}
            columns={table.columns.map(({ name, type }, column) => ({
              id: String(column),
              header: (
                <span className="inline-flex items-baseline gap-1.5">
                  <span>{name}</span>
                  <span className="font-mono text-[11px] font-normal text-fg-subtle">{type}</span>
                </span>
              ),
              align: isNumericType(type) ? "right" : "left",
              cell: ({ values }) => {
                const value = values[column];
                return (
                  <span
                    className={
                      value === null || value === undefined
                        ? "text-fg-subtle"
                        : isNumericType(type)
                          ? "tabular-nums"
                          : undefined
                    }
                  >
                    {cellText(value)}
                  </span>
                );
              },
            }))}
          />
        </div>
      )}
    </div>
  );
}
