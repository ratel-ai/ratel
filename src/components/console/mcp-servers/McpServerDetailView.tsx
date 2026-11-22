"use client";

import { Badge } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { DetectionMarker } from "@/components/console/agents/DetectionMarker";
import { EnvironmentSelect, WindowControl } from "@/components/console/agents/EntityFilters";
import {
  type EntityFilterState,
  ErrorRate,
  ShareMeter,
  StatusChip,
  Toned,
} from "@/components/console/agents/EntityParts";
import type { McpRole } from "@/lib/ingest/otlp/dimensions";
import {
  formatDuration,
  formatInteger,
  formatPercent,
  formatRelativeTime,
} from "@/lib/synthesis/traces/v2/format";
import type { Detection } from "@/lib/views/entities/detection";
import type { AgentRole } from "@/lib/views/project-entities/agents-model";
import { failingToolsHint, latencyHint, mcpStatus } from "@/lib/views/project-entities/mcp-model";
import { ROLE_LABEL } from "./McpServersView";

export type McpToolItem = {
  tool: string;
  calls: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  topError: { message: string; count: number } | null;
  callers: string[];
};

export type McpCallingAgentItem = {
  name: string;
  calls: number;
  role: AgentRole | null;
  href: string | null;
};

export type McpRecentErrorItem = {
  tool: string;
  message: string | null;
  agent: string | null;
  at: string;
  traceId: string;
  href: string;
};

export type McpServerDetailModel = {
  server: {
    key: string;
    role: McpRole;
    displayName: string;
    version: string | null;
    calls: number;
    errors: number;
    errorRate: number;
    p50Ms: number;
    p95Ms: number;
    sessions: number;
    firstSeenAt: string;
    lastSeenAt: string;
    /** How Ratel detected the server (RC-779): shown on its page, guessed or explicit. */
    detection?: Detection | null;
  };
  roles: { role: McpRole; href: string }[];
  tools: McpToolItem[];
  agents: McpCallingAgentItem[];
  recentErrors: McpRecentErrorItem[];
  links: { traces: string; failures: string; catalog: string };
};

/**
 * One MCP server (RC-777, the approved RP-25 design): its status, the KPIs (the error rate says
 * which tool fails; a small sample says its size), its tools by errors with the top error and
 * the callers, the calling agents, and its recent errors with their traces.
 */
export function McpServerDetailView({
  title,
  listHref,
  detail,
  filters,
  failed,
  now,
}: {
  title: string;
  listHref: string;
  detail: McpServerDetailModel | null;
  filters: EntityFilterState;
  failed: boolean;
  now: string;
}) {
  const server = detail?.server;
  const status = server ? mcpStatus(server.errorRate) : null;
  const ghost = buttonVariants({ variant: "ghost", size: "md" });
  return (
    <Page>
      <PageHeader
        crumbs={[{ label: "MCP servers", href: listHref }]}
        title={
          <span className="inline-flex items-center gap-2">
            {title}
            {status ? <StatusChip status={status} /> : null}
            {server?.version ? <Badge>v{server.version}</Badge> : null}
            {server ? <DetectionMarker detection={server.detection ?? null} showExplicit /> : null}
          </span>
        }
        actions={
          <>
            <EnvironmentSelect filters={filters} />
            {detail ? (
              <>
                <Link href={detail.links.traces} className={cn(ghost, "border-line-strong")}>
                  Open in Traces
                </Link>
                <Link href={detail.links.catalog} className={ghost}>
                  Catalog
                </Link>
              </>
            ) : null}
            <WindowControl filters={filters} />
          </>
        }
      />
      <PageBody wide>
        {failed ? (
          <Callout tone="danger" title="The server could not be loaded">
            The read failed. Reload the page to try again.
          </Callout>
        ) : !detail || !server ? (
          <EmptyState
            title="No calls in this window"
            description="This server had no MCP call in the window and environment. Try a longer window."
          />
        ) : (
          <>
            {detail.roles.length > 1 ? <RoleSwitch detail={detail} /> : null}
            <ServerKpis detail={detail} now={now} />
            <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
              <div className="min-w-0 flex-1">
                <ToolsTable tools={detail.tools} />
              </div>
              <div className="flex w-full shrink-0 flex-col gap-4 xl:w-[22rem]">
                <CallingAgents agents={detail.agents} total={server.calls} />
                <RecentErrors
                  errors={detail.recentErrors}
                  allHref={detail.links.failures}
                  now={now}
                />
              </div>
            </div>
          </>
        )}
      </PageBody>
    </Page>
  );
}

function RoleSwitch({ detail }: { detail: McpServerDetailModel }) {
  return (
    <nav aria-label="Seen from" className="flex items-center gap-2 text-ui">
      <span className="text-fg-subtle">Seen from</span>
      {detail.roles.map((each) => (
        <Link
          key={each.role}
          href={each.href}
          aria-current={each.role === detail.server.role ? "page" : undefined}
          className={buttonVariants({
            variant: each.role === detail.server.role ? "secondary" : "ghost",
            size: "sm",
          })}
        >
          {ROLE_LABEL[each.role]}
        </Link>
      ))}
    </nav>
  );
}

function ServerKpis({ detail, now }: { detail: McpServerDetailModel; now: string }) {
  const { server } = detail;
  const status = mcpStatus(server.errorRate);
  const tone = status === "failing" ? "danger" : status === "degraded" ? "warning" : undefined;
  const which = failingToolsHint(detail.tools);
  const agents = detail.agents.filter((agent) => agent.name).length;
  return (
    <StatRow
      stats={[
        {
          label: "Calls",
          value: formatInteger(server.calls),
          hint: (
            <Toned mono>
              {formatInteger(server.sessions)} sessions · {agents} agent{agents === 1 ? "" : "s"}
            </Toned>
          ),
        },
        {
          label: "Error rate",
          value: <Toned tone={tone}>{formatPercent(server.errorRate)}</Toned>,
          hint: (
            <Toned mono tone={server.errors > 0 ? "danger" : undefined}>
              {formatInteger(server.errors)} failed{which ? ` · ${which}` : ""}
            </Toned>
          ),
        },
        {
          label: "p95 latency",
          value: formatDuration(server.p95Ms),
          hint: <Toned mono>{latencyHint(server.calls, server.p50Ms, formatDuration)}</Toned>,
        },
        {
          label: "Last seen",
          value: formatRelativeTime(server.lastSeenAt, now),
          hint: <Toned mono>first seen {formatRelativeTime(server.firstSeenAt, now)}</Toned>,
        },
      ]}
    />
  );
}

function ToolsTable({ tools }: { tools: readonly McpToolItem[] }) {
  const columns: Column<McpToolItem>[] = [
    {
      id: "tool",
      header: "Tool",
      cell: (row) => (
        <div className="flex min-w-0 flex-col py-1.5">
          <span className="truncate font-mono text-xs text-fg">{row.tool}</span>
          {row.topError ? (
            <span className="truncate font-mono text-xs text-danger">
              “{row.topError.message}” ×{formatInteger(row.topError.count)}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: "calls",
      header: "Calls",
      align: "right",
      width: "5rem",
      cell: (row) => formatInteger(row.calls),
    },
    {
      id: "errorRate",
      header: "Error rate",
      align: "right",
      width: "8.5rem",
      cell: (row) => <ErrorRate rate={row.errorRate} status={mcpStatus(row.errorRate)} />,
    },
    {
      id: "p50",
      header: "p50",
      align: "right",
      width: "5rem",
      hiddenBelow: "md",
      cell: (row) => formatDuration(row.p50Ms),
    },
    {
      id: "p95",
      header: "p95",
      align: "right",
      width: "5rem",
      cell: (row) => formatDuration(row.p95Ms),
    },
    {
      id: "callers",
      header: "Callers",
      align: "right",
      width: "8rem",
      cell: (row) => (
        <span className="block truncate" title={row.callers.join(", ")}>
          {row.callers.length === 0 ? "–" : row.callers.join(", ")}
        </span>
      ),
    },
  ];
  return (
    <section aria-labelledby="mcp-tools-title" className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 id="mcp-tools-title" className="text-sm font-semibold text-fg">
          Tools
        </h2>
        <p className="text-ui text-fg-subtle">sorted by errors</p>
      </div>
      <DataTable
        caption="Tools"
        columns={columns}
        rows={tools}
        rowKey={(row) => row.tool}
        empty={<EmptyState title="No tool calls" />}
      />
    </section>
  );
}

function CallingAgents({
  agents,
  total,
}: {
  agents: readonly McpCallingAgentItem[];
  total: number;
}) {
  return (
    <section
      aria-labelledby="calling-agents-title"
      className="rounded-lg border border-line bg-raised"
    >
      <h2
        id="calling-agents-title"
        className="border-b border-line px-4 py-3 text-sm font-semibold text-fg"
      >
        Calling agents
      </h2>
      {agents.length === 0 ? (
        <p className="px-4 py-3 text-ui text-fg-subtle">No span of these calls names an agent.</p>
      ) : (
        <ul className="flex flex-col gap-2 px-4 py-3">
          {agents.map((agent) => (
            <li key={agent.name} className="flex items-center justify-between gap-3 text-ui">
              <span className="flex min-w-0 items-center gap-1.5">
                {agent.href ? (
                  <Link href={agent.href} className="truncate font-medium text-fg hover:underline">
                    {agent.name}
                  </Link>
                ) : (
                  <span className="truncate font-medium text-fg">{agent.name}</span>
                )}
                {agent.role ? (
                  <Badge tone={agent.role === "entry" ? "info" : "neutral"}>{agent.role}</Badge>
                ) : null}
              </span>
              <span className="flex items-center gap-2 font-mono text-xs text-fg-muted tabular-nums">
                {formatInteger(agent.calls)} · {formatPercent(total > 0 ? agent.calls / total : 0)}
                <ShareMeter share={total > 0 ? agent.calls / total : 0} className="w-16" />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentErrors({
  errors,
  allHref,
  now,
}: {
  errors: readonly McpRecentErrorItem[];
  allHref: string;
  now: string;
}) {
  return (
    <section
      aria-labelledby="recent-errors-title"
      className="rounded-lg border border-line bg-raised"
    >
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 id="recent-errors-title" className="text-sm font-semibold text-fg">
          Recent errors
        </h2>
        {errors.length > 0 ? (
          <Link href={allHref} className={buttonVariants({ variant: "secondary", size: "sm" })}>
            All in Traces
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        ) : null}
      </header>
      {errors.length === 0 ? (
        <p className="px-4 py-3 text-ui text-fg-subtle">No failed call in this window.</p>
      ) : (
        <ul className="flex flex-col gap-3 px-4 py-3">
          {errors.map((error) => (
            <li
              key={`${error.traceId}-${error.at}`}
              className="flex min-w-0 flex-col font-mono text-xs"
            >
              <span className="truncate text-danger">
                {error.tool}
                {error.message ? ` · ${error.message}` : ""}
              </span>
              <span className="truncate text-fg-subtle">
                {error.agent ?? "no agent"} · {formatRelativeTime(error.at, now)} ·{" "}
                <Link href={error.href} className="hover:text-fg hover:underline">
                  trace {error.traceId.slice(0, 7)}…
                </Link>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
