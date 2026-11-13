"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { CodeBlock } from "@ratel/design-system/code";
import { type Column, DataTable, type SortDirection } from "@ratel/design-system/data-table";
import { FilterBar, FilterChip, SearchInput } from "@ratel/design-system/filter-bar";
import { Menu, MenuContent, MenuGroup, MenuItem, MenuTrigger } from "@ratel/design-system/menu";
import { PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { stepIndex } from "@ratel/design-system/peek";
import { Section } from "@ratel/design-system/section";
import { StatRow } from "@ratel/design-system/stat-row";
import { EmptyState } from "@ratel/design-system/states";
import { Tooltip } from "@ratel/design-system/tooltip";
import { Filter, SearchX } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  fmtCompact,
  fmtDateTime,
  fmtExact,
  fmtMoney,
  fmtRelative,
  plural,
} from "@/lib/console/catalog/format";
import {
  itemKey,
  withItemParam,
  withQueryParam,
  withQueryParams,
} from "@/lib/console/catalog/item-id";
import { summarizeTools, type ToolItem } from "@/lib/console/catalog/items";
import type { ToolsCatalogData } from "@/lib/console/catalog/load";
import { pageWindow, parsePage } from "@/lib/console/catalog/paging";
import { itemMatchesQuery } from "@/lib/console/catalog/skills-view";
import { TOOL_CATALOG_SNIPPET } from "@/lib/console/catalog/sync-snippet";
import {
  filterToolsCatalogRows,
  type ProvenanceFilter,
  presentProvenances,
  resolveToolsCatalogView,
  sortToolsCatalogRows,
  type ToolsCatalogSortKey,
} from "@/lib/console/catalog/table-view";
import { CATALOG_STALE_DAYS } from "@/lib/ingest/catalogs/vocabulary";
import { APP_NAME } from "@/lib/platform/app-config";
import { CatalogItemDetail } from "./CatalogItemDetail";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { TablePager } from "./TablePager";
import { useCatalogStore } from "./use-catalog-store";
import { useSearchParamState, useUrlWriter } from "./use-url-param";

const PROVENANCE_LABEL: Record<Exclude<ProvenanceFilter, "all">, string> = {
  managed: "Managed",
  observed: "Observed",
  cloud: `${APP_NAME}`,
};

function None() {
  return <span className="text-fg-subtle">None</span>;
}

/**
 * The Tools page: the numbers, then every tool in one table. Search, the
 * source filter, the sort, the page and the open row live in the URL (`q`,
 * `provenance`, `sort`, `dir`, `page`, `peek`), the parameters the v1 table
 * used, so old links still land. A row opens the shared item detail in a Panel.
 */
export function ToolsCatalog({
  projectId,
  now,
  data,
}: {
  projectId: string;
  now: string;
  data: ToolsCatalogData;
}) {
  const store = useCatalogStore({ projectId, tools: data });
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const write = useUrlWriter();
  const view = resolveToolsCatalogView(Object.fromEntries(searchParams.entries()));
  const [query, setQuery] = useSearchParamState("q", ["page"]);
  const peek = usePeek();
  // The Panel keeps showing the last tool while it animates closed.
  const [lastOpen, setLastOpen] = useState<string | null>(peek.id);
  const root = `/project/${encodeURIComponent(projectId)}`;

  const totals = useMemo(() => summarizeTools(data.tools), [data.tools]);
  const itemsByName = useMemo(
    () => new Map(store.toolItems.map((item) => [item.name, item])),
    [store.toolItems],
  );
  const available = useMemo(() => presentProvenances(store.toolRows), [store.toolRows]);

  // `?highlight=<tool>` (Adaptive ranking's "go to catalog") opens that tool, when it is here.
  const highlight = searchParams.get("highlight");
  const highlightFound = highlight !== null && itemsByName.has(highlight);
  useEffect(() => {
    if (highlight === null) return;
    const search = withQueryParam(window.location.search, "highlight", null);
    window.history.replaceState(
      null,
      "",
      `${pathname}${highlightFound ? withQueryParam(search, "peek", highlight) : search}`,
    );
  }, [highlight, highlightFound, pathname]);

  const filtered = useMemo(
    () =>
      sortToolsCatalogRows(
        filterToolsCatalogRows(store.toolRows, { query: "", provenance: view.provenance }),
        view.sort,
        view.direction,
      )
        .map((row) => itemsByName.get(row.tool.name))
        .filter((item): item is ToolItem => item !== undefined && itemMatchesQuery(item, query)),
    [store.toolRows, itemsByName, query, view.provenance, view.sort, view.direction],
  );
  // A search typed but not yet in the URL starts from the first page.
  const range = pageWindow(
    filtered.length,
    query === view.query ? parsePage(searchParams.get("page")) : 1,
  );
  const visible = filtered.slice(range.offset, range.end);

  function open(name: string) {
    setLastOpen(name);
    peek.open(name);
  }

  function clearFilters() {
    setQuery("");
    write({ provenance: null, page: null });
  }

  const sortHref = (id: ToolsCatalogSortKey) => (direction: SortDirection) =>
    `${pathname}${withQueryParams(`?${searchParams.toString()}`, { sort: id, dir: direction, page: null })}`;
  // A plain click sorts in place: the rows are already here, so no loader needs to run again.
  const sortInPlace = (id: ToolsCatalogSortKey) => (direction: SortDirection) =>
    write({ sort: id, dir: direction, page: null });

  const columns: readonly Column<ToolItem>[] = [
    {
      id: "name",
      header: "Name",
      sortHref: sortHref("name"),
      onSort: sortInPlace("name"),
      defaultDirection: "asc",
      cell: (item) => (
        <span className="block max-w-72 truncate font-mono text-xs">{item.name}</span>
      ),
    },
    {
      id: "searchable",
      header: "Searchable description",
      className: "w-full max-w-0",
      cell: (item) => (
        <span className="block truncate text-fg-muted">
          {item.searchable?.text ?? item.agentDescription ?? <None />}
        </span>
      ),
    },
    {
      id: "calls",
      header: "Calls",
      align: "right",
      sortHref: sortHref("calls"),
      onSort: sortInPlace("calls"),
      cell: (item) => fmtExact(item.calls),
    },
    {
      id: "tokens",
      header: "Input tokens",
      align: "right",
      sortHref: sortHref("tokens"),
      onSort: sortInPlace("tokens"),
      cell: (item) => (item.tokens === null ? <None /> : fmtExact(item.tokens)),
    },
    {
      id: "cost",
      header: "Cost",
      align: "right",
      sortHref: sortHref("cost"),
      onSort: sortInPlace("cost"),
      cell: (item) => (item.costUsd === null ? <None /> : fmtMoney(item.costUsd)),
    },
    {
      id: "lastSeen",
      header: "Last seen",
      align: "right",
      sortHref: sortHref("lastSeen"),
      onSort: sortInPlace("lastSeen"),
      className: "whitespace-nowrap",
      cell: (item) =>
        item.lastSeenAt ? (
          <Tooltip content={fmtDateTime(item.lastSeenAt)}>
            <time dateTime={item.lastSeenAt}>{fmtRelative(item.lastSeenAt, now)}</time>
          </Tooltip>
        ) : (
          <span className="text-fg-subtle">Never</span>
        ),
    },
    {
      id: "source",
      header: "Source",
      className: "whitespace-nowrap",
      cell: (item) => (
        <span className="inline-flex items-center gap-1.5">
          <ProvenanceBadge provenance={item.provenance} />
          {item.stale ? (
            <Badge tone="warning">Not synced in {CATALOG_STALE_DAYS} days</Badge>
          ) : null}
        </span>
      ),
    },
  ];

  const openIndex = visible.findIndex((item) => item.name === peek.id);
  const shown = itemsByName.get(peek.id ?? lastOpen ?? "") ?? null;
  const step = (direction: 1 | -1) => {
    const next = visible[stepIndex(openIndex, direction, visible.length)];
    if (next) open(next.name);
  };
  const narrowed = query.trim() !== "" || view.provenance !== "all";
  const snippet = (caption: string) => (
    <CodeBlock
      caption={caption}
      samples={[{ label: "TypeScript", code: TOOL_CATALOG_SNIPPET }]}
      className="w-full max-w-3xl"
    />
  );

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Catalog", href: `${root}/catalogs` }]}
        title="Tools"
        actions={
          <Link href={`${root}/playground`} className={buttonVariants({ variant: "secondary" })}>
            Test a search
          </Link>
        }
      />
      <PageBody wide>
        {totals.tools === 0 ? (
          <div className="flex flex-col items-center gap-4">
            <EmptyState
              emblem
              title="No tools yet"
              description="Tools show up here once your agent calls them or your runtime registers them."
            />
            {data.syncGuide ? snippet("Register tools with the SDK") : null}
          </div>
        ) : (
          <>
            <StatRow
              stats={[
                { label: "Tools", value: fmtExact(totals.tools) },
                {
                  label: "Calls",
                  value: fmtCompact(totals.calls),
                  hint: totals.callsExact ? "Counted by your runtime" : "Estimated from traces",
                },
                {
                  label: "Input tokens",
                  value: totals.observed ? fmtCompact(totals.tokens) : "None",
                },
                { label: "Cost", value: totals.observed ? fmtMoney(totals.costUsd) : "None" },
              ]}
            />
            <section aria-label="Tools" className="flex scroll-mt-16 flex-col gap-3">
              <FilterBar
                search={
                  <SearchInput
                    value={query}
                    onValueChange={setQuery}
                    placeholder="Search tools…"
                    label="Search tools"
                  />
                }
                chips={
                  view.provenance !== "all" ? (
                    <FilterChip
                      field="Source is"
                      value={PROVENANCE_LABEL[view.provenance]}
                      onRemove={() => write({ provenance: null, page: null })}
                    />
                  ) : null
                }
                addFilter={
                  available.length > 1 ? (
                    <Menu>
                      <MenuTrigger render={<Button size="sm" variant="ghost" />}>
                        <Filter aria-hidden strokeWidth={1.5} />
                        Filter
                      </MenuTrigger>
                      <MenuContent>
                        <MenuGroup label="Source">
                          {available.map((provenance) => (
                            <MenuItem
                              key={provenance}
                              onClick={() => write({ provenance, page: null })}
                            >
                              {PROVENANCE_LABEL[provenance]}
                            </MenuItem>
                          ))}
                        </MenuGroup>
                      </MenuContent>
                    </Menu>
                  ) : null
                }
                end={
                  <span className="text-xs text-fg-subtle tabular-nums">
                    {narrowed
                      ? `${fmtExact(filtered.length)} of ${plural(totals.tools, "tool")}`
                      : plural(totals.tools, "tool")}
                  </span>
                }
              />
              <DataTable
                caption="Tools"
                columns={columns}
                rows={visible}
                rowKey={(item) => item.name}
                sort={{ id: view.sort, direction: view.direction }}
                selectedKey={peek.id}
                onRowOpen={(item) => open(item.name)}
                empty={
                  <EmptyState
                    icon={SearchX}
                    title="No tools match"
                    description="Clear the search or the filter to see every tool."
                    action={
                      <Button size="sm" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    }
                  />
                }
              />
              <TablePager
                window={range}
                total={filtered.length}
                onPage={(page) => write({ page: page === 1 ? null : String(page) })}
              />
            </section>
            {data.syncGuide ? (
              <Section
                title="Register tools with the SDK"
                description="Definitions synced from your runtime show up here as managed tools."
              >
                {snippet("TypeScript")}
              </Section>
            ) : null}
          </>
        )}
      </PageBody>

      <Panel
        open={peek.id !== null && itemsByName.has(peek.id)}
        onOpenChange={(next) => {
          if (!next) peek.close();
        }}
        title={<span className="font-mono">{shown?.name ?? ""}</span>}
        actions={
          shown ? (
            <Link
              href={`${root}/catalogs${withItemParam("", itemKey("tool", shown.name))}`}
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              Show in catalog
            </Link>
          ) : null
        }
        onPrevious={() => step(-1)}
        onNext={() => step(1)}
      >
        {shown ? (
          <CatalogItemDetail
            item={shown}
            now={now}
            layout="panel"
            adopted={{ tool: data.adopted, skill: null }}
            onSaveSearchable={store.saveSearchable}
            onResetSearchable={store.resetSearchable}
            draft={store.drafts.get(shown.key) ?? null}
            onDraftChange={(item, draft) => store.setDraft(item.key, draft)}
          />
        ) : null}
      </Panel>
    </>
  );
}
