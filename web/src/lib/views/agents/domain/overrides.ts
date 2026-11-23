/**
 * Agent overrides (RC-776): what a person corrects in what detection found.
 * An override renames an agent, hides it, or merges its key into another
 * agent's key. Overrides apply at read time: stored spans never change, so
 * every override is reversible.
 *
 * A merge is one hop: a merged key's target is never merged itself, and a key
 * that other keys merge into is never merged. So no chain and no cycle.
 */

export interface AgentOverride {
  agentKey: string;
  displayName: string | null;
  hidden: boolean;
  mergedInto: string | null;
}

/** A change to one agent's override. An absent field keeps its value; null clears it. */
export interface AgentOverrideChange {
  agentKey: string;
  displayName?: string | null;
  hidden?: boolean;
  mergedInto?: string | null;
}

export type OverrideRejection =
  | "merge_into_itself"
  | "merge_target_is_merged"
  | "agent_is_merge_target";

export const OVERRIDE_REJECTIONS: Readonly<Record<OverrideRejection, string>> = {
  merge_into_itself: "An agent cannot be merged into itself.",
  merge_target_is_merged:
    "The target agent is merged into another agent. Merge into that agent instead, or undo its merge first.",
  agent_is_merge_target:
    "Other agents are merged into this agent. Undo those merges first, or merge them into the new target.",
};

export const MAX_DISPLAY_NAME = 120;

/** The override after the change, or why the change is rejected. */
export function applyOverrideChange(
  current: readonly AgentOverride[],
  change: AgentOverrideChange,
): { ok: true; override: AgentOverride } | { ok: false; reason: OverrideRejection } {
  const byKey = new Map(current.map((row) => [row.agentKey, row]));
  const before = byKey.get(change.agentKey) ?? {
    agentKey: change.agentKey,
    displayName: null,
    hidden: false,
    mergedInto: null,
  };
  const displayName =
    change.displayName === undefined
      ? before.displayName
      : change.displayName?.trim().slice(0, MAX_DISPLAY_NAME) || null;
  const after: AgentOverride = {
    agentKey: change.agentKey,
    displayName,
    hidden: change.hidden ?? before.hidden,
    mergedInto: change.mergedInto === undefined ? before.mergedInto : change.mergedInto,
  };
  if (after.mergedInto !== null && after.mergedInto !== before.mergedInto) {
    if (after.mergedInto === after.agentKey) return { ok: false, reason: "merge_into_itself" };
    if (byKey.get(after.mergedInto)?.mergedInto)
      return { ok: false, reason: "merge_target_is_merged" };
    if (current.some((row) => row.mergedInto === after.agentKey))
      return { ok: false, reason: "agent_is_merge_target" };
  }
  return { ok: true, override: after };
}

/** An override that changes nothing: its row can go. */
export function isEmptyOverride(override: AgentOverride): boolean {
  return override.displayName === null && !override.hidden && override.mergedInto === null;
}

/** What the reads need from the overrides: merge sources to targets, names, hidden keys. */
export interface OverrideView {
  /** Merged key to its target. */
  merges: ReadonlyMap<string, string>;
  names: ReadonlyMap<string, string>;
  hidden: ReadonlySet<string>;
}

export const NO_OVERRIDES: OverrideView = {
  merges: new Map(),
  names: new Map(),
  hidden: new Set(),
};

export function overrideView(rows: readonly AgentOverride[]): OverrideView {
  return {
    merges: new Map(
      rows.flatMap((row) => (row.mergedInto ? [[row.agentKey, row.mergedInto] as const] : [])),
    ),
    names: new Map(
      rows.flatMap((row) => (row.displayName ? [[row.agentKey, row.displayName] as const] : [])),
    ),
    hidden: new Set(rows.filter((row) => row.hidden).map((row) => row.agentKey)),
  };
}

/** The agent a key reads as: its merge target, else itself. */
export function canonicalKey(view: OverrideView, key: string): string {
  return view.merges.get(key) ?? key;
}

/** The keys whose spans read as `key`: itself and every key merged into it. */
export function sourceKeys(view: OverrideView, key: string): string[] {
  return [
    key,
    ...[...view.merges]
      .filter(([, target]) => target === key)
      .map(([source]) => source)
      .sort(),
  ];
}

/** The name an agent shows: its override, else its key. */
export function displayNameOf(view: OverrideView, key: string): string {
  return view.names.get(key) ?? key;
}

/**
 * Per-agent counts another surface read (the MCP server page's calling
 * agents), as the overrides show them: merged keys summed under their target,
 * each named by its override. A null agent (none named) stays null.
 */
export function agentsAsOverridden<T extends { agent: string | null; calls: number }>(
  rows: readonly T[],
  overrides: readonly AgentOverride[],
): T[] {
  if (overrides.length === 0) return [...rows];
  const view = overrideView(overrides);
  const merged = new Map<string | null, T>();
  for (const row of rows) {
    const agent = row.agent === null ? null : displayNameOf(view, canonicalKey(view, row.agent));
    const before = merged.get(agent);
    merged.set(agent, before ? { ...before, calls: before.calls + row.calls } : { ...row, agent });
  }
  return [...merged.values()].sort(
    (a, b) =>
      b.calls - a.calls ||
      (a.agent === null ? 1 : b.agent === null ? -1 : a.agent.localeCompare(b.agent)),
  );
}
