"use client";

import { Badge } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { type Column, DataTable, type SortDirection } from "@ratel/design-system/data-table";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { Bot } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
  formatDuration,
  formatInteger,
  formatMoney,
  formatPercent,
  formatRelativeTime,
  formatTimestamp,
} from "@/lib/synthesis/traces/v2/format";
import { AGENTS_SHOW_HIDDEN_PARAM } from "@/lib/views/agents/paths";
import {
  type AgentListEntry,
  type AgentSort,
  type AgentSortColumn,
  type AgentTreeRow,
  agentErrorPill,
  agentTree,
  type Handoff,
  handoffChain,
  handoffMapLayout,
  sortAgentRows,
} from "@/lib/views/project-entities/agents-model";
import { AgentHandoffMap } from "./AgentHandoffMap";
import { EntityFilters, WindowControl } from "./EntityFilters";
import { type EntityFilterState, ErrorPill, ShareMeter, Toned, Trend } from "./EntityParts";

/** An agent row as the page sends it: dates as ISO strings, its page, its runs per day. */
export type AgentListItem = AgentListEntry & {
  firstSeenAt: string;
  href: string;
  hidden: boolean;
  /** Runs per day of the window, oldest first. */
  daily: number[];
  /** The MCP servers it calls. */
  mcpServers: number;
};

type Row = AgentTreeRow<AgentListItem>;

/**
 * The Agents list (RC-775, the approved RP-25 design): which agents run, what they cost, which
 * one fails, and who hands work to whom. A KPI band, the filter row, the table nested by handoff
 * (a sort by a column flattens it), and the handoff map beside it.
 */
export function AgentsView({
  agents,
  handoffs,
  filters,
  hiddenCount,
  canEdit,
  showHidden,
  now,
}: {
  /** Null: the read failed. */
  agents: AgentListItem[] | null;
  handoffs: Handoff[];
  filters: EntityFilterState;
  /** Hidden agents in the window; their toggle is for admins. */
  hiddenCount: number;
  canEdit: boolean;
  showHidden: boolean;
  now: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<AgentSort | null>(null);
  const tree = useMemo(() => agentTree(agents ?? [], handoffs), [agents, handoffs]);
  const map = useMemo(() => handoffMapLayout(tree, handoffs), [tree, handoffs]);
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const sorted = sortAgentRows(tree, sort);
    return needle
      ? sorted.filter(
          (row) =>
            row.agent.displayName.toLowerCase().includes(needle) ||
            row.agent.key.toLowerCase().includes(needle),
        )
      : sorted;
  }, [tree, sort, search]);
  const totalCost = (agents ?? []).reduce((sum, agent) => sum + agent.costUsd, 0);

  const header = <PageHeader title="Agents" actions={<WindowControl filters={filters} />} />;
  if (agents === null) {
    return (
      <Page>
        {header}
        <PageBody wide>
          <Callout tone="danger" title="Agents could not be loaded">
            The read failed. Reload the page to try again.
          </Callout>
        </PageBody>
      </Page>
    );
  }

  const sortColumn = (id: AgentSortColumn) => ({
    sortHref: (direction: SortDirection) => `?sort=${id}&direction=${direction}`,
    onSort: (direction: SortDirection) => setSort({ id, direction }),
  });
  const columns: Column<Row>[] = [
    {
      id: "name",
      header: "Agent",
      ...sortColumn("name"),
      defaultDirection: "asc",
      cell: (row) => <AgentCell row={row} />,
    },
    {
      id: "runs",
      header: "Runs",
      align: "right",
      width: "5rem",
      ...sortColumn("runs"),
      cell: (row) => formatInteger(row.agent.calls),
    },
    {
      id: "trend",
      header: "Trend",
      width: "6rem",
      hiddenBelow: "md",
      cell: (row) => <Trend values={row.agent.daily} />,
    },
    {
      id: "cost",
      header: "Cost",
      align: "right",
      width: "8rem",
      ...sortColumn("cost"),
      cell: (row) => (
        <span className="inline-flex items-center justify-end gap-2">
          {formatMoney(row.agent.costUsd)}
          <ShareMeter share={totalCost > 0 ? row.agent.costUsd / totalCost : 0} />
        </span>
      ),
    },
    {
      id: "errorRate",
      header: "Error rate",
      align: "right",
      width: "9rem",
      ...sortColumn("errorRate"),
      cell: (row) => (
        <ErrorPill
          rate={row.agent.errorRate}
          failed={row.agent.errors}
          pill={agentErrorPill(row.agent.errorRate)}
        />
      ),
    },
    {
      id: "p95",
      header: "p95 run",
      align: "right",
      width: "7rem",
      hiddenBelow: "lg",
      ...sortColumn("p95"),
      className: "whitespace-nowrap",
      cell: (row) => formatDuration(row.agent.p95Ms),
    },
    {
      id: "lastSeen",
      header: "Last seen",
      align: "right",
      width: "7rem",
      ...sortColumn("lastSeen"),
      cell: (row) => (
        <span title={`First seen ${formatTimestamp(row.agent.firstSeenAt)}`}>
          {formatRelativeTime(row.agent.lastSeenAt, now)}
        </span>
      ),
    },
  ];

  return (
    <Page>
      {header}
      <PageBody wide>
        {agents.length > 0 ? <AgentsKpis tree={tree} handoffs={handoffs} /> : null}
        <div className="flex flex-col gap-4">
          <EntityFilters
            search={search}
            onSearch={setSearch}
            placeholder="Filter agents…"
            filters={filters}
            end={
              <>
                {sort ? (
                  <button
                    type="button"
                    className={buttonVariants({ variant: "ghost", size: "sm" })}
                    onClick={() => setSort(null)}
                  >
                    Show as tree
                  </button>
                ) : null}
                {canEdit ? <HiddenToggle count={hiddenCount} on={showHidden} /> : null}
              </>
            }
          />
          <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
            <div className="min-w-0 flex-1">
              <DataTable
                caption="Agents"
                columns={columns}
                rows={rows}
                rowKey={(row) => row.agent.key}
                sort={sort ?? undefined}
                onRowOpen={(row) => router.push(row.agent.href)}
                empty={
                  <EmptyState
                    icon={Bot}
                    title={search ? "No agent matches" : "No agents in this window"}
                    description={
                      search
                        ? "Clear the search to see every agent."
                        : "Agents show once spans name them (gen_ai.agent.name) or a handoff is seen. Try a longer window."
                    }
                  />
                }
              />
            </div>
            {map.nodes.length > 0 ? (
              <AgentHandoffMap
                layout={map}
                hrefs={Object.fromEntries(tree.map((row) => [row.agent.key, row.agent.href]))}
              />
            ) : null}
          </div>
        </div>
      </PageBody>
    </Page>
  );
}

/** The KPI band: agents, entry runs with their trend, cost and its top share, failed runs, handoffs. */
function AgentsKpis({ tree, handoffs }: { tree: readonly Row[]; handoffs: readonly Handoff[] }) {
  const entries = tree.filter((row) => row.depth === 0);
  const subAgents = tree.length - entries.length;
  const runs = entries.reduce((sum, row) => sum + row.agent.calls, 0);
  const failed = entries.reduce((sum, row) => sum + row.agent.errors, 0);
  const cost = tree.reduce((sum, row) => sum + row.agent.costUsd, 0);
  const top = [...tree].sort((a, b) => b.agent.costUsd - a.agent.costUsd)[0];
  const daily = entries.reduce<number[]>(
    (sum, row) => row.agent.daily.map((value, index) => value + (sum[index] ?? 0)),
    [],
  );
  const shown = new Set(tree.map((row) => row.agent.key));
  const handoffCount = handoffs
    .filter((edge) => shown.has(edge.from) && shown.has(edge.to))
    .reduce((sum, edge) => sum + edge.count, 0);
  const chain = handoffChain(tree);
  const runsWord = subAgents > 0 ? "entry runs" : "runs";
  return (
    <StatRow
      stats={[
        {
          label: "Agents",
          value: formatInteger(tree.length),
          hint:
            subAgents > 0 ? (
              <Toned mono>
                {entries.length} entry · {subAgents} sub-agent{subAgents === 1 ? "" : "s"}
              </Toned>
            ) : undefined,
        },
        {
          label: "Runs",
          value: formatInteger(runs),
          hint: subAgents > 0 ? <Toned mono>by entry agents</Toned> : undefined,
          trend: daily.length > 1 ? <Trend values={daily} tone="accent" width={104} /> : undefined,
        },
        {
          label: "Cost",
          value: formatMoney(cost),
          hint:
            top && cost > 0 ? (
              <Toned mono>
                {formatPercent(top.agent.costUsd / cost)} {top.agent.displayName}
              </Toned>
            ) : undefined,
        },
        {
          label: "Failed runs",
          value: <Toned tone={failed > 0 ? "danger" : undefined}>{formatInteger(failed)}</Toned>,
          hint:
            runs > 0 ? (
              <Toned mono tone={failed > 0 ? "danger" : undefined}>
                {formatPercent(failed / runs)} of {runsWord}
              </Toned>
            ) : undefined,
        },
        {
          label: "Handoffs",
          value: formatInteger(handoffCount),
          hint: chain.length > 0 ? <Toned mono>{chain.join(" → ")}</Toned> : undefined,
        },
      ]}
    />
  );
}

/** The agent cell: the tree mark, the name, the role chip, and who it comes from or what it reaches. */
function AgentCell({ row }: { row: Row }) {
  const { agent, depth, role, parent, callees } = row;
  const reach = [
    agent.mcpServers > 0
      ? `calls ${agent.mcpServers} MCP server${agent.mcpServers === 1 ? "" : "s"}`
      : null,
    callees.length > 0 ? `hands off to ${callees.join(", ")}` : null,
  ].filter(Boolean);
  const line = depth > 0 && parent ? `from ${parent.name} ×${parent.count}` : reach.join(" · ");
  return (
    <div
      className="flex min-w-0 items-start gap-1.5 py-1.5"
      style={{ paddingLeft: depth > 0 ? `${(depth - 1) * 1.25 + 0.25}rem` : undefined }}
    >
      {depth > 0 ? (
        <span aria-hidden className="mt-0.5 font-mono text-xs text-fg-faint">
          └─
        </span>
      ) : null}
      <div className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <Link
            href={agent.href}
            className="truncate text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          >
            {agent.displayName}
          </Link>
          {role ? <Badge tone={role === "entry" ? "info" : "neutral"}>{role}</Badge> : null}
          {agent.hidden ? <Badge>hidden</Badge> : null}
        </span>
        {line ? <span className="truncate text-xs text-fg-subtle">{line}</span> : null}
      </div>
    </div>
  );
}

/** "Hidden (n)": an admin's filter, in the filter row with its count (RC-776). */
function HiddenToggle({ count, on }: { count: number; on: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  function toggle() {
    const query = new URLSearchParams(params.toString());
    if (on) query.delete(AGENTS_SHOW_HIDDEN_PARAM);
    else query.set(AGENTS_SHOW_HIDDEN_PARAM, "1");
    const search = query.toString();
    router.push(search ? `${pathname}?${search}` : pathname);
  }
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={toggle}
      className={cn(buttonVariants({ variant: "secondary", size: "sm" }), on && "bg-selected")}
    >
      Hidden ({count})
    </button>
  );
}
