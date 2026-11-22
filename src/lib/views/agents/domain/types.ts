/**
 * The agents of a project as entities (RC-775): each agent key ingest derives
 * on `otel_spans.agent_key` (RC-772), with its volume, cost, errors and
 * latency, the tools and MCP servers it uses, and the handoffs between agents
 * (`caller_agent_key -> agent_key`).
 *
 * One agent run is the spans of one agent in one trace. Its latency is from
 * its first span's start to its last span's end in that trace.
 */

import type { Detection } from "@/lib/views/entities/detection";

export interface AgentWindow {
  since: Date;
  /** Exclusive. */
  until: Date;
  /** Narrows to the traces of one environment (`otel_trace_summaries.environment`); the agents stay the same entities. */
  environment?: string | null;
}

export interface AgentRow {
  /** The agent's key: a merge target reads the spans of every key merged into it. */
  key: string;
  /** Its override name (RC-776), else the key. */
  displayName: string;
  /** Hidden by an override: only listed when hidden agents are asked for. */
  hidden: boolean;
  /** The keys merged into this agent, whose history it sums. */
  mergedKeys: string[];
  /** Runs: the traces the agent ran in. */
  calls: number;
  /** Runs with an error span of the agent. */
  errors: number;
  errorRate: number;
  costUsd: number;
  p95Ms: number;
  /** Within the window. */
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** How Ratel detected the agent: the weakest source of its spans (RC-779); null on spans stored before RC-772. */
  detection: Detection | null;
}

export interface AgentList {
  agents: AgentRow[];
  /** Every environment of the window's traces with an agent, whatever the filter. */
  environments: string[];
}

export interface AgentToolStat {
  tool: string;
  calls: number;
  errors: number;
  errorRate: number;
  p95Ms: number;
}

export interface AgentMcpServerStat {
  server: string;
  calls: number;
  errors: number;
}

export interface AgentHandoff {
  /** The agent that handed work over (its key after merges). */
  from: string;
  /** The agent it handed work to. */
  to: string;
  fromName: string;
  toName: string;
  /** `invoke_agent` spans of the handoff; with none, the traces it happened in. */
  count: number;
}

export interface AgentDetail {
  agent: AgentRow;
  tools: AgentToolStat[];
  mcpServers: AgentMcpServerStat[];
  /** The agents that hand work to this one. */
  callers: AgentHandoff[];
  /** The agents this one hands work to. */
  callees: AgentHandoff[];
}

export interface AgentReadOptions {
  /** List hidden agents and their handoffs too. */
  showHidden?: boolean;
}

/** How far back the navigation looks for agent spans. */
export const AGENTS_NAV_WINDOW_DAYS = 30;

/** The error rate of `errors` out of `calls`, 0 with no call. */
export function rateOf(errors: number, calls: number): number {
  return calls > 0 ? errors / calls : 0;
}

/** A latency to the hundredth of a millisecond: percentile_cont's float noise is not a reading. */
export function roundMs(value: number | string | null): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

/** A cost to the millionth of a dollar, the precision `otel_spans.cost_usd` keeps. */
export function roundUsd(value: number | string | null): number {
  return Math.round(Number(value ?? 0) * 1_000_000) / 1_000_000;
}
