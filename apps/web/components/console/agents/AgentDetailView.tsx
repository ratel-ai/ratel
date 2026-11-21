"use client";

import { Badge } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { ArrowRight, ArrowUpRight, Wrench } from "lucide-react";
import Link from "next/link";
import {
  formatDuration,
  formatInteger,
  formatMoney,
  formatPercent,
  formatRelativeTime,
} from "@/lib/synthesis/traces/v2/format";
import {
  type AgentRole,
  type AgentToolGroup,
  type AgentToolRow,
  agentErrorPill,
} from "@/lib/views/project-entities/agents-model";
import { mcpStatus } from "@/lib/views/project-entities/mcp-model";
import { AgentEditMenu, type AgentEditModel } from "./AgentEditMenu";
import { EnvironmentSelect, WindowControl } from "./EntityFilters";
import { type EntityFilterState, ShareMeter, Toned } from "./EntityParts";

/** A box of the flow strip: a caller or a callee, with its handoffs and its own numbers. */
export type FlowAgent = {
  key: string;
  name: string;
  /** Handoffs between it and this agent. */
  count: number;
  href: string;
  runs: number | null;
  errorRate: number | null;
};

export type AgentDetailModel = {
  agent: {
    key: string;
    displayName: string;
    calls: number;
    errors: number;
    errorRate: number;
    costUsd: number;
    p95Ms: number;
    firstSeenAt: string;
    lastSeenAt: string;
    mergedKeys: string[];
    hidden: boolean;
  };
  role: AgentRole | null;
  mcpServers: number;
  callers: FlowAgent[];
  callees: FlowAgent[];
  tools: AgentToolGroup[];
  /** Each MCP server group's page. */
  serverHrefs: Record<string, string>;
  links: { traces: string; failures: string };
  /** Admins only (RC-776). */
  edit?: AgentEditModel;
};

/**
 * One agent (RC-775, the approved RP-25 design): the header with its role and status and the
 * admin's Edit agent menu, the KPIs with a way to its failures, the flow strip (who hands it work,
 * whom it hands work to), and its tools grouped by MCP server, then the built-in ones.
 */
export function AgentDetailView({
  title,
  listHref,
  detail,
  filters,
  failed,
  now,
}: {
  title: string;
  listHref: string;
  detail: AgentDetailModel | null;
  filters: EntityFilterState;
  /** The read failed. */
  failed: boolean;
  now: string;
}) {
  const agent = detail?.agent;
  const pill = agent ? agentErrorPill(agent.errorRate) : false;
  return (
    <Page>
      <PageHeader
        crumbs={[{ label: "Agents", href: listHref }]}
        title={
          <span className="inline-flex items-center gap-2">
            {title}
            {detail?.role ? (
              <Badge tone={detail.role === "entry" ? "info" : "neutral"}>{detail.role}</Badge>
            ) : null}
            {agent && pill ? (
              <Badge tone="danger">{formatPercent(agent.errorRate)} errors</Badge>
            ) : null}
            {agent?.hidden ? <Badge>hidden</Badge> : null}
          </span>
        }
        actions={
          <>
            <EnvironmentSelect filters={filters} />
            {detail ? (
              <Link
                href={detail.links.traces}
                className={buttonVariants({ variant: "secondary", size: "md" })}
              >
                Open in Traces
              </Link>
            ) : null}
            {detail?.edit && agent ? (
              <AgentEditMenu
                edit={detail.edit}
                agentKey={agent.key}
                hidden={agent.hidden}
                mergedKeys={agent.mergedKeys}
              />
            ) : null}
            <WindowControl filters={filters} />
          </>
        }
      />
      <PageBody wide>
        {failed ? (
          <Callout tone="danger" title="The agent could not be loaded">
            The read failed. Reload the page to try again.
          </Callout>
        ) : !detail || !agent ? (
          <EmptyState
            title="No runs in this window"
            description="This agent ran no span in the window and environment. Try a longer window."
          />
        ) : (
          <>
            <StatRow
              stats={[
                { label: "Runs", value: formatInteger(agent.calls) },
                {
                  label: "Cost",
                  value: formatMoney(agent.costUsd),
                  hint:
                    agent.calls > 0 ? (
                      <Toned mono>{formatMoney(agent.costUsd / agent.calls)} / run</Toned>
                    ) : undefined,
                },
                {
                  label: "Error rate",
                  value: (
                    <Toned tone={pill ? "danger" : undefined}>
                      {formatPercent(agent.errorRate)}
                    </Toned>
                  ),
                  hint:
                    agent.errors > 0 ? (
                      <Toned mono tone="danger">
                        {formatInteger(agent.errors)} failed ·{" "}
                        <Link
                          href={detail.links.failures}
                          className="relative z-10 underline-offset-2 hover:underline"
                        >
                          view failures →
                        </Link>
                      </Toned>
                    ) : (
                      <Toned mono>no failed run</Toned>
                    ),
                },
                { label: "p95 run", value: formatDuration(agent.p95Ms) },
                {
                  label: "Last seen",
                  value: formatRelativeTime(agent.lastSeenAt, now),
                  hint: <Toned mono>first seen {formatRelativeTime(agent.firstSeenAt, now)}</Toned>,
                },
              ]}
            />
            <FlowStrip detail={detail} />
            <ToolsSection groups={detail.tools} serverHrefs={detail.serverHrefs} />
          </>
        )}
      </PageBody>
    </Page>
  );
}

/** Caller → this agent → callees in one row; a dashed "entry agent" box when nothing calls it. */
function FlowStrip({ detail }: { detail: AgentDetailModel }) {
  const { agent } = detail;
  const name = agent.displayName;
  return (
    <section aria-labelledby="flow-title" className="rounded-lg border border-line">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-3">
        <h2 id="flow-title" className="text-sm font-semibold text-fg">
          Flow
        </h2>
        <p className="text-ui text-fg-subtle">
          who hands work to {name}, and to whom {name} hands work
        </p>
      </header>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 p-4">
        <div className="flex min-w-0 flex-col gap-2">
          {detail.callers.length > 0 ? (
            detail.callers.map((caller) => (
              <FlowBox key={caller.key} agent={caller} verb="hands work" />
            ))
          ) : (
            <div className="rounded-md border border-dashed border-line-strong px-3 py-2">
              <p className="text-ui font-medium text-fg-muted">No caller</p>
              <p className="text-xs text-fg-subtle">entry agent: runs start here</p>
            </div>
          )}
        </div>
        <ArrowRight aria-hidden className="size-4 text-fg-faint" />
        <div className="min-w-0 rounded-md border border-info bg-info-subtle px-3 py-2">
          <p className="truncate text-ui font-semibold text-fg">{name}</p>
          <p className="truncate text-xs text-fg-muted">
            {formatInteger(agent.calls)} runs
            {detail.mcpServers > 0
              ? ` · ${detail.mcpServers} MCP server${detail.mcpServers === 1 ? "" : "s"}`
              : ""}
          </p>
        </div>
        <ArrowRight aria-hidden className="size-4 text-fg-faint" />
        <div className="flex min-w-0 flex-col gap-2">
          {detail.callees.length > 0 ? (
            detail.callees.map((callee) => (
              <FlowBox key={callee.key} agent={callee} verb="handed work" />
            ))
          ) : (
            <div className="rounded-md border border-dashed border-line-strong px-3 py-2">
              <p className="text-ui font-medium text-fg-muted">No callee</p>
              <p className="text-xs text-fg-subtle">{name} hands work to no agent</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function FlowBox({ agent, verb }: { agent: FlowAgent; verb: string }) {
  const failing = agent.errorRate !== null && agentErrorPill(agent.errorRate);
  return (
    <Link
      href={agent.href}
      className={cn(
        "min-w-0 rounded-md border px-3 py-2 outline-none transition-colors duration-120 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus",
        failing ? "border-danger" : "border-line-strong",
      )}
    >
      <p className="truncate text-ui font-medium text-fg">{agent.name}</p>
      <p className="truncate text-xs text-fg-subtle">
        {verb} ×{formatInteger(agent.count)}
        {agent.runs !== null ? ` · ${formatInteger(agent.runs)} runs` : ""}
        {agent.errorRate !== null ? ` · ${formatPercent(agent.errorRate)} errors` : ""}
      </p>
    </Link>
  );
}

/** The tools by source: each MCP server (linked to its page), then the built-in ones. */
function ToolsSection({
  groups,
  serverHrefs,
}: {
  groups: readonly AgentToolGroup[];
  serverHrefs: Record<string, string>;
}) {
  const tools = groups.reduce(
    (sum, group) =>
      sum +
      group.rows.reduce((count, row) => count + (row.kind === "tool" ? 1 : row.tools.length), 0),
    0,
  );
  const fromServers = groups.filter((group) => group.server !== null).length;
  return (
    <section aria-labelledby="tools-title" className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 id="tools-title" className="text-sm font-semibold text-fg">
          Tools
        </h2>
        <p className="text-ui text-fg-subtle">
          {formatInteger(tools)} tool{tools === 1 ? "" : "s"}
          {fromServers > 0 ? ` · ${fromServers} MCP server${fromServers === 1 ? "" : "s"}` : ""}
        </p>
      </div>
      {groups.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="No tool calls in this window"
          description="The agent called no tool in the window and environment."
          className="rounded-lg border border-line py-8"
        />
      ) : (
        <table className="w-full border-separate border-spacing-0 text-ui">
          <caption className="sr-only">Tools by source</caption>
          <thead>
            <tr>
              {["Tool", "Calls", "Errors", "Error rate", "p95"].map((label, index) => (
                <th
                  key={label}
                  scope="col"
                  className={cn(
                    "h-9 border-b border-line px-3 text-xs font-medium whitespace-nowrap text-fg-subtle",
                    index === 0 ? "text-left" : "w-28 text-right",
                  )}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <ToolGroupRows
                key={group.server ?? "built-in"}
                group={group}
                href={group.server ? serverHrefs[group.server] : undefined}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ToolGroupRows({ group, href }: { group: AgentToolGroup; href?: string }) {
  return (
    <>
      <tr>
        <th
          scope="rowgroup"
          colSpan={5}
          className="h-8 border-b border-line bg-raised px-3 text-left text-ui font-normal text-fg-muted"
        >
          {group.server ? (
            <span className="inline-flex items-center gap-1.5">
              MCP ·
              {href ? (
                <Link
                  href={href}
                  className="inline-flex items-center gap-0.5 text-info outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {group.server}
                  <ArrowUpRight aria-hidden className="size-3" />
                </Link>
              ) : (
                <span className="text-fg">{group.server}</span>
              )}
              <span className="text-fg-subtle">
                {formatInteger(group.calls)} calls · {formatInteger(group.errors)} error
                {group.errors === 1 ? "" : "s"}
              </span>
            </span>
          ) : (
            "Built-in"
          )}
        </th>
      </tr>
      {group.rows.map((row) => (
        <ToolRow key={row.kind === "tool" ? row.tool.tool : "folded"} row={row} />
      ))}
    </>
  );
}

function ToolRow({ row }: { row: AgentToolRow }) {
  const cell = "h-9 border-b border-line px-3 text-right tabular-nums text-fg";
  if (row.kind === "folded") {
    const shown = row.tools.slice(0, 3);
    const more = row.tools.length - shown.length;
    return (
      <tr>
        <td
          className="h-9 border-b border-line px-3 font-mono text-xs text-fg-muted"
          title={row.tools.join(", ")}
        >
          {shown.join(" · ")}
          {more > 0 ? ` · +${more} more` : ""}
        </td>
        <td className={cell}>{formatInteger(row.calls)}</td>
        <td className={cell}>{formatInteger(row.errors)}</td>
        <td className={cell}>
          <RateCell rate={row.calls > 0 ? row.errors / row.calls : 0} />
        </td>
        <td className={cell}>{formatDuration(row.p95Ms)}</td>
      </tr>
    );
  }
  const { tool } = row;
  return (
    <tr>
      <td className="h-9 border-b border-line px-3">
        <span className="inline-flex min-w-0 items-baseline gap-3">
          <span className="font-mono text-xs text-fg">{tool.tool}</span>
          {tool.errors > 0 && tool.lastError ? (
            <span className="truncate font-mono text-xs text-danger" title="The newest error">
              {tool.lastError}
            </span>
          ) : null}
        </span>
      </td>
      <td className={cell}>{formatInteger(tool.calls)}</td>
      <td className={cell}>{formatInteger(tool.errors)}</td>
      <td className={cell}>
        <RateCell rate={tool.errorRate} />
      </td>
      <td className={cell}>{formatDuration(tool.p95Ms)}</td>
    </tr>
  );
}

function RateCell({ rate }: { rate: number }) {
  const status = mcpStatus(rate);
  return (
    <span className="inline-flex items-center justify-end gap-2">
      {formatPercent(rate)}
      <ShareMeter
        share={rate}
        tone={status === "failing" ? "danger" : status === "degraded" ? "warning" : "neutral"}
      />
    </span>
  );
}
