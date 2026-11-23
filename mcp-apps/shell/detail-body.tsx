"use client";

/**
 * One entity from a detail binding: its key facts, then sections of key/value
 * pairs, compact tables and lists. Shared by the detail view and the list
 * view's Panel, so a row opens to exactly what the detail tool shows.
 */
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { NounIcon } from "@ratel/design-system/entity";
import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import type { ReactNode } from "react";
import { Cell, type CellOptions, isNumeric, Redacted } from "./cells";
import { type ColumnConfig, type DetailConfig, type FieldConfig, getPath } from "./config";
import { formatValue } from "./format";
import type { ToolSuccess } from "./state";

function Fields({
  fields,
  source,
  withheld,
}: {
  fields: FieldConfig[];
  source: unknown;
  withheld: boolean;
}) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-ui">
      {fields.map((field) => (
        <div key={field.key} className="contents">
          <dt className="text-fg-subtle">{field.label}</dt>
          <dd className="min-w-0 text-fg tabular-nums">
            <Cell field={field} source={source} options={{ context: "detail", withheld }} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** `render` draws a cell another way (the list view's console cells); Cell by default. */
export function tableColumns<T>(
  columns: ColumnConfig[],
  rows: readonly T[],
  withheld: boolean,
  render: (props: { field: ColumnConfig; source: T; options: CellOptions }) => ReactNode = ({
    field,
    source,
    options,
  }) => <Cell field={field} source={source} options={options} />,
): Column<T>[] {
  return columns.map((column) => {
    const max =
      column.format === "bar"
        ? Math.max(0, ...rows.map((row) => Number(getPath(row, column.key)) || 0))
        : undefined;
    return {
      id: column.key,
      header: column.label,
      align: column.align ?? (isNumeric(column) ? "right" : "left"),
      width: column.width,
      hiddenBelow: column.hiddenBelow,
      cell: (row: T) =>
        render({ field: column, source: row, options: { context: "table", withheld, max } }),
    };
  });
}

export function DetailBody({ config, result }: { config: DetailConfig; result: ToolSuccess }) {
  const entity = getPath(result.data, config.root);
  const withheld = Boolean((result.data as { contentWithheld?: boolean } | null)?.contentWithheld);
  if (entity === null || entity === undefined) {
    return (
      <Callout tone="warning" title="Nothing to show">
        The tool answered without the {config.noun ?? "item"} this view expects.
      </Callout>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {withheld ? (
        <Callout tone="info" title="Some text is redacted">
          Captured text is shown to signed-in members, or to API keys once content reading is on in
          project Settings.
        </Callout>
      ) : null}
      <Fields fields={config.fields} source={entity} withheld={withheld} />
      {(config.sections ?? []).map((section) => {
        const value = getPath(entity, section.key) ?? getPath(result.data, section.key);
        if (section.kind === "fields") {
          if (!value || typeof value !== "object") return null;
          return (
            <Section key={section.title} title={section.title}>
              <Fields fields={section.fields ?? []} source={value} withheld={withheld} />
            </Section>
          );
        }
        const rows = Array.isArray(value) ? value : [];
        if (rows.length === 0) return null;
        if (section.kind === "list") {
          return (
            <Section key={section.title} title={section.title}>
              <ul className="flex flex-col gap-1.5 text-ui text-fg">
                {rows.map((item, index) => {
                  const text =
                    item !== null && typeof item === "object" ? getPath(item, "text") : item;
                  return (
                    <li key={index} className="rounded-md border border-line bg-raised px-3 py-2">
                      {text === null || text === undefined ? (
                        withheld ? (
                          <Redacted />
                        ) : (
                          <span className="text-fg-faint">–</span>
                        )
                      ) : (
                        String(text)
                      )}
                    </li>
                  );
                })}
              </ul>
            </Section>
          );
        }
        return (
          <Section key={section.title} title={`${section.title} (${rows.length})`}>
            <DataTable
              caption={section.title}
              density="compact"
              columns={tableColumns(section.columns ?? [], rows, withheld)}
              rows={rows}
              rowKey={(row) =>
                String(getPath(row, section.columns?.[0]?.key ?? "id") ?? JSON.stringify(row)) +
                rows.indexOf(row)
              }
            />
          </Section>
        );
      })}
      {result.truncated ? (
        <p className="text-xs text-fg-subtle">
          Some lists are cut short; the tool returns the first rows only.
        </p>
      ) : null}
    </div>
  );
}

export function DetailHeader({ config, data }: { config: DetailConfig; data: unknown }) {
  const entity = getPath(data, config.root);
  return (
    <div className="flex min-w-0 items-center gap-2">
      {config.noun ? <NounIcon noun={config.noun} className="size-4" /> : null}
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold text-fg">
          {formatValue(getPath(entity, config.title), "text")}
        </h1>
        {config.subtitle ? (
          <p className="truncate font-mono text-xs text-fg-subtle">
            {formatValue(
              getPath(entity, config.subtitle) ?? getPath(data, config.subtitle),
              "text",
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
}
