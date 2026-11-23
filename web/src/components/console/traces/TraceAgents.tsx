"use client";

import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Section } from "@ratel/design-system/section";
import type { AgentSubtree } from "@/lib/synthesis/traces/v2/agent-rollup";
import { costLabel } from "@/lib/synthesis/traces/v2/cost-label";
import { formatDuration, formatInteger } from "@/lib/synthesis/traces/v2/format";
import { TURN_NOUN as noun } from "@/lib/synthesis/traces/v2/run-noun";
import { TruncatedText } from "./cells";

/** Indentation per nesting level, capped like the timeline's. */
const INDENT_PX = 16;
const MAX_INDENT_LEVELS = 8;

/**
 * A run's agents (AOBS-5): the main agent, then each sub-agent under the
 * agent that started it, with the tokens, cost and duration of its whole
 * subtree. A row selects the agent's step in the timeline below.
 */
export function TraceAgents({
  agents,
  truncated,
  selectedSpanId,
  onSelect,
}: {
  agents: readonly AgentSubtree[];
  /** The run is longer than the spans read: the totals cover the spans shown. */
  truncated: boolean;
  selectedSpanId: string | null;
  onSelect: (spanId: string) => void;
}) {
  const columns: Column<AgentSubtree>[] = [
    {
      id: "agent",
      header: "Agent",
      className: "w-full max-w-0 min-w-48",
      cell: (row) => (
        <span
          className="flex min-w-0 items-center"
          style={{ paddingLeft: Math.min(row.depth, MAX_INDENT_LEVELS) * INDENT_PX }}
        >
          <TruncatedText text={row.name} className="text-fg" />
        </span>
      ),
    },
    {
      id: "model",
      header: "Model",
      width: "12rem",
      hiddenBelow: "md",
      cell: (row) =>
        row.model ? (
          <TruncatedText text={row.model} className="text-fg-muted" />
        ) : (
          <span className="text-fg-subtle">—</span>
        ),
    },
    {
      id: "modelCalls",
      header: "Model calls",
      align: "right",
      width: "7rem",
      hiddenBelow: "sm",
      cell: (row) => formatInteger(row.modelCalls),
    },
    {
      id: "toolCalls",
      header: "Tool calls",
      align: "right",
      width: "6.5rem",
      hiddenBelow: "sm",
      cell: (row) => formatInteger(row.toolCalls),
    },
    {
      id: "failed",
      header: "Failed",
      align: "right",
      width: "5.5rem",
      hiddenBelow: "md",
      cell: (row) => (
        <span className="inline-flex items-center justify-end gap-1.5">
          {row.failedSpans > 0 ? (
            <span aria-hidden className="size-1.5 rounded-full bg-danger" />
          ) : null}
          {formatInteger(row.failedSpans)}
        </span>
      ),
    },
    {
      id: "tokens",
      header: "Tokens",
      align: "right",
      width: "7rem",
      cell: (row) => formatInteger(row.tokens),
    },
    {
      id: "cost",
      header: "Cost",
      align: "right",
      width: "7.5rem",
      cell: (row) => costLabel(row.costUsd, row.unpricedCalls),
    },
    {
      id: "duration",
      header: "Duration",
      align: "right",
      width: "6.5rem",
      cell: (row) => formatDuration(row.durationMs),
    },
  ];
  return (
    <Section
      title="Agents"
      description={
        truncated
          ? `Each agent's totals over the first 5,000 spans of this ${noun.lower}, its sub-agents included.`
          : "Each agent's totals include the sub-agents it started."
      }
    >
      <DataTable
        caption="Agents"
        density="compact"
        columns={columns}
        rows={agents}
        rowKey={(row) => row.spanId}
        selectedKey={selectedSpanId}
        onRowOpen={(row) => onSelect(row.spanId)}
      />
    </Section>
  );
}
