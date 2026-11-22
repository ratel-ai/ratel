"use client";

import { Badge } from "@ratel/design-system/badge";
import { type Column, DataTable, type SortDirection } from "@ratel/design-system/data-table";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Select } from "@ratel/design-system/select";
import { StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { Server } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { DetectionMarker } from "@/components/console/agents/DetectionMarker";
import { EntityFilters, WindowControl } from "@/components/console/agents/EntityFilters";
import {
  type EntityFilterState,
  ErrorRate,
  StatusChip,
  Toned,
  Trend,
} from "@/components/console/agents/EntityParts";
import type { McpRole } from "@/lib/ingest/otlp/dimensions";
import {
  formatDuration,
  formatInteger,
  formatPercent,
  formatRelativeTime,
  formatTimestamp,
} from "@/lib/synthesis/traces/v2/format";
import type { Detection } from "@/lib/views/entities/detection";
import type { McpServerGuide } from "@/lib/views/mcp-servers/setup-guide";
import {
  type McpSort,
  type McpSortColumn,
  type McpStatus,
  mcpStatus,
  onePerServer,
  showSeenFrom,
  sortMcpServers,
  statusRank,
} from "@/lib/views/project-entities/mcp-model";
import { McpServerSetupGuide } from "./McpServerSetupGuide";

/** A server side as the page sends it: dates as ISO strings, its page and what it reaches. */
export type McpServerListItem = {
  key: string;
  role: McpRole;
  displayName: string;
  calls: number;
  errors: number;
  errorRate: number;
  p95Ms: number;
  sessions: number;
  firstSeenAt: string;
  lastSeenAt: string;
  href: string;
  /** Calls per day of the window, oldest first. */
  daily: number[];
  tools: string[];
  /** Calling agents' names, busiest first. */
  agents: string[];
  lastError: { tool: string; message: string } | null;
  /** How Ratel detected the server (RC-779): a guess shows a marker. */
  detection?: Detection | null;
};

/** Which side of the call the spans came from. */
export const ROLE_LABEL: Record<McpRole, string> = { consumed: "Agent", provided: "Server" };

const STATUS_FILTERS = ["all", "failing", "degraded", "healthy"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/**
 * The MCP servers list (RC-777, the approved RP-25 design): which servers the agents call, which
 * one fails, and how far each reaches. A KPI band, the filter row, then one row per server side,
 * failing first.
 */
export function McpServersView({
  servers,
  filters,
  tabs,
  guide,
  now,
}: {
  /** Null: the read failed. */
  servers: McpServerListItem[] | null;
  /** The standard OpenTelemetry setup guide (RC-780), open while the list is empty. */
  guide?: McpServerGuide;
  filters: EntityFilterState;
  /** The MCP page's tabs (Servers, Clients, RC-778); absent on pages without them. */
  tabs?: ReactNode;
  now: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<McpSort | null>(null);
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const kept = (servers ?? []).filter(
      (row) =>
        (status === "all" || mcpStatus(row.errorRate) === status) &&
        (!needle ||
          row.displayName.toLowerCase().includes(needle) ||
          row.tools.some((tool) => tool.toLowerCase().includes(needle))),
    );
    return sort ? sortBy(kept, sort) : sortMcpServers(kept);
  }, [servers, search, status, sort]);

  const header = (
    <PageHeader title="MCP servers" actions={<WindowControl filters={filters} />} tabs={tabs} />
  );
  if (servers === null) {
    return (
      <Page>
        {header}
        <PageBody wide>
          <Callout tone="danger" title="MCP servers could not be loaded">
            The read failed. Reload the page to try again.
          </Callout>
          {guide ? <McpServerSetupGuide guide={guide} defaultOpen={false} /> : null}
        </PageBody>
      </Page>
    );
  }

  const sortColumn = (id: McpSortColumn) => ({
    sortHref: (direction: SortDirection) => `?sort=${id}&direction=${direction}`,
    onSort: (direction: SortDirection) => setSort({ id, direction }),
  });
  const columns: Column<McpServerListItem>[] = [
    {
      id: "name",
      header: "Server",
      defaultDirection: "asc",
      ...sortColumn("name"),
      cell: (row) => <ServerCell row={row} />,
    },
    ...(showSeenFrom(servers)
      ? [
          {
            id: "role",
            header: "Seen from",
            width: "6rem",
            cell: (row: McpServerListItem) => <Badge>{ROLE_LABEL[row.role]}</Badge>,
          },
        ]
      : []),
    {
      id: "status",
      header: "Status",
      align: "right",
      width: "6.5rem",
      defaultDirection: "asc",
      ...sortColumn("status"),
      cell: (row) => <StatusChip status={mcpStatus(row.errorRate)} />,
    },
    {
      id: "calls",
      header: "Calls",
      align: "right",
      width: "5rem",
      ...sortColumn("calls"),
      cell: (row) => formatInteger(row.calls),
    },
    {
      id: "trend",
      header: "Trend",
      width: "6rem",
      hiddenBelow: "md",
      cell: (row) => (
        <Trend
          values={row.daily}
          tone={mcpStatus(row.errorRate) === "failing" ? "danger" : "neutral"}
        />
      ),
    },
    {
      id: "errorRate",
      header: "Error rate",
      align: "right",
      width: "8.5rem",
      ...sortColumn("errorRate"),
      cell: (row) => <ErrorRate rate={row.errorRate} status={mcpStatus(row.errorRate)} />,
    },
    {
      id: "p95",
      header: "p95",
      align: "right",
      width: "5.5rem",
      ...sortColumn("p95"),
      cell: (row) => formatDuration(row.p95Ms),
    },
    {
      id: "tools",
      header: "Tools",
      align: "right",
      width: "4.5rem",
      hiddenBelow: "lg",
      ...sortColumn("tools"),
      cell: (row) => formatInteger(row.tools.length),
    },
    {
      id: "agents",
      header: "Agents",
      width: "8rem",
      hiddenBelow: "lg",
      ...sortColumn("agents"),
      cell: (row) => (
        <span className="block truncate" title={row.agents.join(", ")}>
          {row.agents.length === 0
            ? "–"
            : row.agents.length <= 2
              ? row.agents.join(", ")
              : `${row.agents[0]} +${row.agents.length - 1}`}
        </span>
      ),
    },
    {
      id: "lastSeen",
      header: "Last seen",
      align: "right",
      width: "6.5rem",
      ...sortColumn("lastSeen"),
      cell: (row) => (
        <span title={`First seen ${formatTimestamp(row.firstSeenAt)}`}>
          {formatRelativeTime(row.lastSeenAt, now)}
        </span>
      ),
    },
  ];

  return (
    <Page>
      {header}
      <PageBody wide>
        {servers.length > 0 ? <McpKpis servers={servers} /> : null}
        <div className="flex flex-col gap-4">
          <EntityFilters
            search={search}
            onSearch={setSearch}
            placeholder="Filter servers…"
            filters={filters}
            end={
              sort ? (
                <button
                  type="button"
                  className="text-ui text-fg-muted hover:text-fg"
                  onClick={() => setSort(null)}
                >
                  Sort by status
                </button>
              ) : undefined
            }
          >
            <Select
              aria-label="Status"
              className="w-auto"
              value={status}
              onValueChange={(value) => setStatus(value as StatusFilter)}
              options={STATUS_FILTERS.map((value) => ({ value, label: `Status: ${value}` }))}
            />
          </EntityFilters>
          <DataTable
            caption="MCP servers"
            columns={columns}
            rows={rows}
            rowKey={(row) => `${row.key}|${row.role}`}
            sort={sort ?? undefined}
            onRowOpen={(row) => router.push(row.href)}
            empty={
              <EmptyState
                icon={Server}
                title={servers.length === 0 ? "No MCP calls in this window" : "No server matches"}
                description={
                  servers.length === 0
                    ? "A server shows once an agent calls one of its tools (an MCP client span) or the server exports its own spans. Try a longer window."
                    : "Clear the search or the status filter to see every server."
                }
              />
            }
          />
        </div>
        {guide ? <McpServerSetupGuide guide={guide} defaultOpen={servers.length === 0} /> : null}
      </PageBody>
    </Page>
  );
}

/** The KPI band: servers and failing ones, calls and sessions, failed calls, the slowest p95. */
function McpKpis({ servers: rows }: { servers: readonly McpServerListItem[] }) {
  const servers = onePerServer(rows);
  const failing = servers.filter((row) => mcpStatus(row.errorRate) === "failing").length;
  const calls = servers.reduce((sum, row) => sum + row.calls, 0);
  const sessions = servers.reduce((sum, row) => sum + row.sessions, 0);
  const errors = servers.reduce((sum, row) => sum + row.errors, 0);
  const slowest = [...servers].sort((a, b) => b.p95Ms - a.p95Ms)[0];
  const errorTone = errors > 0 ? "danger" : undefined;
  return (
    <StatRow
      stats={[
        {
          label: "Servers",
          value: formatInteger(servers.length),
          hint: (
            <Toned mono tone={failing > 0 ? "danger" : undefined}>
              {failing} failing
            </Toned>
          ),
        },
        {
          label: "Calls",
          value: formatInteger(calls),
          hint: <Toned mono>{formatInteger(sessions)} sessions</Toned>,
        },
        {
          label: "Failed calls",
          value: <Toned tone={errorTone}>{formatInteger(errors)}</Toned>,
          hint: (
            <Toned mono tone={errorTone}>
              {formatPercent(calls > 0 ? errors / calls : 0)} of calls
            </Toned>
          ),
        },
        {
          label: "Slowest p95",
          value: slowest ? formatDuration(slowest.p95Ms) : "–",
          hint: slowest ? <Toned mono>{slowest.displayName}</Toned> : undefined,
        },
      ]}
    />
  );
}

/** The server's name, then its last error when it fails, else the tools it serves. */
function ServerCell({ row }: { row: McpServerListItem }) {
  const failing: McpStatus = mcpStatus(row.errorRate);
  const line =
    failing === "failing" && row.lastError
      ? `${row.lastError.tool}: ${row.lastError.message}`
      : row.tools.slice(0, 4).join(", ") + (row.tools.length > 4 ? ", …" : "");
  return (
    <div className="flex min-w-0 flex-col py-1.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <Link
          href={row.href}
          className="truncate text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
        >
          {row.displayName}
        </Link>
        <DetectionMarker detection={row.detection ?? null} />
      </span>
      {line ? (
        <span
          className={
            failing === "failing" && row.lastError
              ? "truncate font-mono text-xs text-danger"
              : "truncate text-xs text-fg-subtle"
          }
        >
          {line}
        </span>
      ) : null}
    </div>
  );
}

function sortBy(rows: readonly McpServerListItem[], sort: McpSort): McpServerListItem[] {
  const value: Record<McpSortColumn, (row: McpServerListItem) => number | string> = {
    name: (row) => row.displayName.toLowerCase(),
    status: (row) => statusRank(row.errorRate),
    calls: (row) => row.calls,
    errorRate: (row) => row.errorRate,
    p95: (row) => row.p95Ms,
    tools: (row) => row.tools.length,
    agents: (row) => row.agents.length,
    lastSeen: (row) => Date.parse(row.lastSeenAt),
  };
  const read = value[sort.id];
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = read(a);
    const right = read(b);
    const order =
      typeof left === "string" && typeof right === "string"
        ? left.localeCompare(right)
        : Number(left) - Number(right);
    return sign * order || b.calls - a.calls;
  });
}
