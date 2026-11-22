import type { ExplorerScope, StoredIntentChain } from "@/lib/readings/tool-explorer/types";
import { EXPLORER_SCOPES } from "@/lib/readings/tool-explorer/types";
import { formatDuration as formatSharedDuration } from "@/lib/readings/trace-signals/claims";

/**
 * Pure view helpers for the Tool Explorer page: parsing the URL, the asks
 * with their tools, and the few formats the page prints. No database, no
 * React.
 */

export function parseScope(value: string | string[] | undefined): ExplorerScope {
  const first = Array.isArray(value) ? value[0] : value;
  return EXPLORER_SCOPES.includes(first as ExplorerScope) ? (first as ExplorerScope) : "turn";
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export { formatCount } from "@/lib/readings/trace-signals/claims";

/** "always together" for the set table's badge. */
export function scopeNoun(scope: ExplorerScope, plural = true): string {
  return scope === "turn" ? (plural ? "turns" : "turn") : plural ? "sessions" : "session";
}

/** One intent's tools, as the panel draws them. */
export interface IntentToolsView {
  intentId: string;
  text: string;
  units: number;
  groupLabel: string | null;
  tools: { toolId: string; n: number; share: number; shareLow: number }[];
  /** The commonest ordered call chains of this ask's units, biggest first; `share` is of the ask's units. */
  chains: { tools: string[]; n: number; share: number }[];
  /** Calls the ask's units made in all; 0 on runs stored before it was kept. */
  calls: number;
}

/**
 * Intent rows grouped per intent, biggest intents first, each tool list by
 * share. `groupLabel` names the lexical group the intent fell into, when the
 * run grouped it with others.
 */
export function intentToolsView(
  rows: readonly {
    intentId: string;
    intentText: string | null;
    intentUnits: number;
    toolId: string;
    n: number;
    share: number;
    shareLow: number;
  }[],
  groups: readonly {
    id: string;
    label: string;
    intentIds: readonly string[];
  }[] = [],
  top = 40,
  chains: Record<string, readonly StoredIntentChain[]> = {},
  calls: Record<string, number> = {},
): IntentToolsView[] {
  const groupOf = new Map<string, string>();
  for (const group of groups)
    if (group.intentIds.length > 1) for (const id of group.intentIds) groupOf.set(id, group.label);
  const byIntent = new Map<string, IntentToolsView>();
  for (const row of rows) {
    let view = byIntent.get(row.intentId);
    if (!view) {
      view = {
        intentId: row.intentId,
        text: row.intentText ?? row.intentId,
        units: row.intentUnits,
        groupLabel: groupOf.get(row.intentId) ?? null,
        chains: (chains[row.intentId] ?? []).map((chain) => ({
          tools: chain.t,
          n: chain.n,
          share: chain.n / Math.max(1, row.intentUnits),
        })),
        calls: calls[row.intentId] ?? 0,
        tools: [],
      };
      byIntent.set(row.intentId, view);
    }
    view.tools.push({
      toolId: row.toolId,
      n: row.n,
      share: row.share,
      shareLow: row.shareLow,
    });
  }
  return [...byIntent.values()]
    .map((view) => ({
      ...view,
      tools: view.tools.sort((x, y) => y.share - x.share || (x.toolId < y.toolId ? -1 : 1)),
    }))
    .sort((x, y) => y.units - x.units || (x.intentId < y.intentId ? -1 : 1))
    .slice(0, top);
}

/**
 * Agent health's duration ("340 ms", "1.2 s", "12 s", "3 min"), so the same
 * milliseconds read the same on both pages, plus the two cases only this page
 * meets: an absent value prints as a dash, and a window total past an hour
 * prints in hours.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  return formatSharedDuration(ms);
}
