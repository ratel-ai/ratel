import type { AgentOverride, AgentOverrideChange, OverrideRejection } from "../domain/overrides";
import type {
  AgentDetail,
  AgentHandoff,
  AgentList,
  AgentReadOptions,
  AgentWindow,
} from "../domain/types";

/**
 * The read port of the Agents page. Every read is scoped to one project and
 * bounded by a window, and applies the project's agent overrides (RC-776).
 */
export interface AgentStore {
  /** The project's agents in the window, busiest first; hidden ones only with `showHidden`. */
  listAgents(
    projectId: string,
    window: AgentWindow,
    options?: AgentReadOptions,
  ): Promise<AgentList>;
  /** Every environment of the window's traces with an agent; the window's `environment` is ignored. */
  listAgentEnvironments(projectId: string, window: AgentWindow): Promise<string[]>;
  /** One agent's stats, tools, MCP servers and handoffs; a merged key reads as its target; null with no span in the window. */
  getAgent(projectId: string, key: string, window: AgentWindow): Promise<AgentDetail | null>;
  /** Every handoff between two agents in the window, busiest first; none with a hidden agent unless `showHidden`. */
  listHandoffs(
    projectId: string,
    window: AgentWindow,
    options?: AgentReadOptions,
  ): Promise<AgentHandoff[]>;
  /** Of these projects, the ones with multi-agent data since `now` less `AGENTS_NAV_WINDOW_DAYS`. */
  projectsWithAgents(projectIds: readonly string[], now: Date): Promise<string[]>;
  /** The project's overrides. */
  listOverrides(projectId: string): Promise<AgentOverride[]>;
}

/** The write port of agent overrides. */
export interface AgentOverrideStore {
  /**
   * Applies one change to one agent's override, checked against the project's
   * other overrides in the same transaction. An override that changes nothing
   * is deleted.
   */
  changeOverride(
    projectId: string,
    change: AgentOverrideChange,
    actor: string,
  ): Promise<{ ok: true; override: AgentOverride } | { ok: false; reason: OverrideRejection }>;
}
