import { Button } from "@ratel/design-system/button";
import { DataTable } from "@ratel/design-system/data-table";
import { FilterBar, FilterChip, SearchInput } from "@ratel/design-system/filter-bar";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ratel/design-system/menu";
import { Panel } from "@ratel/design-system/panel";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { ListFilter, SearchX } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type RatelView, useRatelView } from "../../shell/bridge";
import {
  detailArgs,
  fillTemplate,
  getPath,
  initialSort,
  type ListConfig,
  type ListOrder,
  listSource,
  parseDetailConfig,
  parseListConfig,
} from "../../shell/config";
import { ConsoleCell } from "../../shell/console-cells";
import { DetailBody, tableColumns } from "../../shell/detail-body";
import { compareValues, formatValue, sortValue } from "../../shell/format";
import { mountView } from "../../shell/mount";
import type { ToolFailure, ToolSuccess } from "../../shell/state";
import { DefaultSkeleton, ViewFrame } from "../../shell/view-frame";
import { detailBindings } from "../detail/bindings";
import view, { type ListBinding } from "./bindings";

type Row = Record<string, unknown>;
type Active = { key: string; value: string };

function matches(row: Row, config: ListConfig, query: string, active: Active[]): boolean {
  for (const filter of active) {
    const definition = config.filters?.find((item) => item.key === filter.key);
    const value = getPath(row, filter.key);
    if (definition?.kind === "flag" ? !value : String(value) !== filter.value) return false;
  }
  if (!query) return true;
  const needle = query.toLowerCase();
  return (config.search ?? [config.title]).some((key) => {
    const value = getPath(row, key);
    return value !== null && value !== undefined && String(value).toLowerCase().includes(needle);
  });
}

function DetailPanel({
  view: ratel,
  config,
  row,
  onClose,
  onStep,
}: {
  view: RatelView;
  config: ListConfig;
  row: Row | null;
  onClose: () => void;
  onStep: (delta: number) => void;
}) {
  const detail = config.detail;
  const binding = detail ? detailBindings.find((item) => item.tool === detail.tool) : undefined;
  const [answer, setAnswer] = useState<{
    key: string;
    result: ToolSuccess | null;
    error: ToolFailure | null;
  } | null>(null);
  const key = row ? String(getPath(row, config.rowKey)) : null;

  useEffect(() => {
    if (!row || !detail || !key) return;
    let live = true;
    void ratel.callTool(detail.tool, detailArgs(detail.args, row)).then((read) => {
      if (live)
        setAnswer(
          read.ok
            ? { key, result: read.value, error: null }
            : { key, result: null, error: read.error },
        );
    });
    return () => {
      live = false;
    };
    // Only a different row asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, detail?.tool]);

  const title = row ? formatValue(getPath(row, config.title), "text") : "";
  const current = answer && answer.key === key ? answer : null;
  const detailConfig = binding ? parseDetailConfig(binding.tool, binding.config) : null;
  const href =
    current?.result && detailConfig
      ? detailConfig.href
        ? (getPath(current.result.data, detailConfig.href) as string | undefined)
        : detailConfig.consolePath
          ? fillTemplate(detailConfig.consolePath, current.result.data, ratel.state.input)
          : null
      : null;

  return (
    <Panel
      open={row !== null}
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={title}
      subtitle={key ?? undefined}
      onPrevious={() => onStep(-1)}
      onNext={() => onStep(1)}
      actions={
        href ? (
          <Button variant="ghost" size="sm" onClick={() => ratel.openInConsole(href)}>
            Open in Ratel
          </Button>
        ) : null
      }
    >
      {!detail || !detailConfig ? (
        <Callout tone="info">This list has no detail view.</Callout>
      ) : current?.error ? (
        <Callout tone="danger" title="Could not open it">
          {current.error.message}
        </Callout>
      ) : current?.result ? (
        <DetailBody config={detailConfig} result={current.result} />
      ) : (
        <DefaultSkeleton />
      )}
    </Panel>
  );
}

function List({ result, ratel }: { result: ToolSuccess; ratel: RatelView<unknown, ListBinding> }) {
  const binding = ratel.binding;
  // The rows are the tool's data, or its view model when the binding draws the list from that (config.ts, fromView).
  const drawn = useMemo(
    () => (binding ? listSource(parseListConfig(binding.tool, binding.config), result) : null),
    [binding, result],
  );
  const config = drawn?.config ?? null;
  const [pages, setPages] = useState<{ rows: Row[]; cursor: string | null }[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<Active[]>([]);
  // The order the call asked for (its `sort` argument) stays the tool's; a header click makes it the view's.
  const [order, setOrder] = useState<ListOrder>(() =>
    config ? initialSort(config, ratel.state.input) : { sort: undefined, serverOrder: false },
  );
  const sort = order.sort;
  const [openKey, setOpenKey] = useState<string | null>(null);

  if (!config)
    return (
      <Callout tone="warning" title="No binding">
        This view does not know how to show {ratel.state.toolName ?? "this tool"}.
      </Callout>
    );

  const firstRows = (getPath(drawn?.source, config.rows) as Row[] | undefined) ?? [];
  const firstCursor = config.cursor
    ? ((getPath(result.data, config.cursor.next) as string | null | undefined) ?? null)
    : null;
  const allRows = [firstRows, ...pages.map((page) => page.rows)].flat();
  const cursor = pages.length > 0 ? pages[pages.length - 1].cursor : firstCursor;
  const withheld = Boolean((result.data as { contentWithheld?: boolean } | null)?.contentWithheld);

  const visible = allRows.filter((row) => matches(row, config, query, active));
  if (sort && !order.serverOrder) {
    const column = config.columns.find((item) => item.key === sort.id);
    visible.sort((a, b) =>
      compareValues(
        sortValue(getPath(a, sort.id), column?.format),
        sortValue(getPath(b, sort.id), column?.format),
        sort.direction,
      ),
    );
  }

  // An optional column (a run's tools) shows only when some row has it.
  const shownColumns = config.columns.filter(
    (column) => !column.optional || allRows.some((row) => getPath(row, column.key) != null),
  );
  const columns = tableColumns<Row>(shownColumns, visible, withheld, (props) => (
    <ConsoleCell {...props} />
  )).map((column, index) =>
    shownColumns[index].sortable === false
      ? column
      : {
          ...column,
          onSort: (direction: "asc" | "desc") =>
            setOrder({ sort: { id: column.id, direction }, serverOrder: false }),
          defaultDirection:
            shownColumns[index].format === "text" || !shownColumns[index].format
              ? ("asc" as const)
              : ("desc" as const),
        },
  );

  const openIndex =
    openKey === null
      ? -1
      : visible.findIndex((row) => String(getPath(row, config.rowKey)) === openKey);
  const openRow = openIndex >= 0 ? visible[openIndex] : null;

  async function loadMore() {
    if (!config?.cursor || !cursor || !ratel.state.toolName) return;
    setLoadingMore(true);
    setMoreError(null);
    const read = await ratel.callTool(ratel.state.toolName, {
      ...(ratel.state.input ?? {}),
      [config.cursor.param]: cursor,
    });
    setLoadingMore(false);
    if (!read.ok) {
      setMoreError(read.error.message);
      return;
    }
    const rows = (getPath(read.value.data, config.rows) as Row[] | undefined) ?? [];
    const next =
      (getPath(read.value.data, config.cursor.next) as string | null | undefined) ?? null;
    setPages((previous) => [...previous, { rows, cursor: next }]);
  }

  const valueFilters = (config.filters ?? []).filter(
    (filter) => !active.some((item) => item.key === filter.key),
  );
  const optionsFor = (key: string) =>
    [
      ...new Set(
        allRows
          .map((row) => getPath(row, key))
          .filter((value) => value !== null && value !== undefined && value !== "")
          .map(String),
      ),
    ].sort();

  return (
    <div className={openRow ? "flex min-h-[34rem] flex-col gap-3" : "flex flex-col gap-3"}>
      <FilterBar
        search={
          <SearchInput
            value={query}
            onValueChange={setQuery}
            placeholder={`Search ${config.noun.many}`}
            label={`Search ${config.noun.many}`}
            className="w-56"
          />
        }
        chips={active.map((item) => {
          const definition = config.filters?.find((filter) => filter.key === item.key);
          return (
            <FilterChip
              key={item.key}
              field={definition?.label ?? item.key}
              value={
                definition?.kind === "flag"
                  ? "yes"
                  : (definition?.badgeLabels?.[item.value] ?? item.value)
              }
              onRemove={() =>
                setActive((previous) => previous.filter((entry) => entry.key !== item.key))
              }
            />
          );
        })}
        addFilter={
          valueFilters.length > 0 && allRows.length > 0 ? (
            <Menu>
              <MenuTrigger render={<Button variant="ghost" size="sm" />}>
                <ListFilter aria-hidden className="size-3.5" />
                Filter
              </MenuTrigger>
              <MenuContent>
                {valueFilters.flatMap((filter) =>
                  filter.kind === "flag"
                    ? [
                        <MenuItem
                          key={filter.key}
                          onClick={() =>
                            setActive((previous) => [
                              ...previous,
                              { key: filter.key, value: "true" },
                            ])
                          }
                        >
                          {filter.label}
                        </MenuItem>,
                      ]
                    : optionsFor(filter.key).map((value) => (
                        <MenuItem
                          key={`${filter.key}:${value}`}
                          onClick={() =>
                            setActive((previous) => [...previous, { key: filter.key, value }])
                          }
                        >
                          {filter.label}: {filter.badgeLabels?.[value] ?? value}
                        </MenuItem>
                      )),
                )}
              </MenuContent>
            </Menu>
          ) : null
        }
        end={
          <span className="text-xs text-fg-subtle tabular-nums">
            {visible.length === allRows.length
              ? `${allRows.length} ${allRows.length === 1 ? config.noun.one : config.noun.many}`
              : `${visible.length} of ${allRows.length}`}
          </span>
        }
      />
      <DataTable
        caption={config.noun.many}
        columns={columns}
        rows={visible}
        rowKey={(row) => String(getPath(row, config.rowKey))}
        sort={sort}
        selectedKey={openKey}
        onRowOpen={
          config.detail ? (row) => setOpenKey(String(getPath(row, config.rowKey))) : undefined
        }
        empty={
          allRows.length > 0 ? (
            <EmptyState
              icon={SearchX}
              title={`No ${config.noun.many} match`}
              description="Clear the search or a filter."
            />
          ) : (
            <EmptyState
              emblem
              title={config.empty?.title ?? `No ${config.noun.many}`}
              description={config.empty?.description}
            />
          )
        }
      />
      {moreError ? (
        <Callout tone="danger" title="Could not load more">
          {moreError}
        </Callout>
      ) : null}
      {cursor ? (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            loading={loadingMore}
            onClick={() => void loadMore()}
          >
            Load more {config.noun.many}
          </Button>
        </div>
      ) : result.truncated && !config.cursor ? (
        <p className="text-xs text-fg-subtle">
          The first {allRows.length} are shown. Ask with narrower filters to see the rest.
        </p>
      ) : null}
      <DetailPanel
        view={ratel as RatelView}
        config={config}
        row={openRow}
        onClose={() => setOpenKey(null)}
        onStep={(delta) => {
          const next = visible[openIndex + delta];
          if (next) setOpenKey(String(getPath(next, config.rowKey)));
        }}
      />
    </div>
  );
}

function ListView() {
  const ratel = useRatelView<unknown, ListBinding>();
  return (
    <ViewFrame<unknown, ListBinding>>
      {(result) => <List result={result} ratel={ratel} />}
    </ViewFrame>
  );
}

mountView({ name: "list", bindings: view.bindings }, <ListView />);
