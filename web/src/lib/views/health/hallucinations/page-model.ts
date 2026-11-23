import {
  GROUP_OF,
  HALLUCINATION_GROUPS,
  HALLUCINATION_KINDS,
  type HallucinationGroup,
  type HallucinationKind,
  kindOf,
} from "@/lib/readings/trace-signals/hallucinations/kinds";
import type { StoredAlias } from "@/lib/readings/trace-signals/hallucinations/run";
import type { WindowDays } from "@/lib/readings/trace-signals/view";
import type { HallucinationsQuery } from "@/lib/views/health/hallucinations/paths";
import type { ToolNameCheck } from "@/lib/views/health/hallucinations/tool-names";

/**
 * The Hallucinations page (pure): how often the agent made something up, the
 * groups by their share of all occurrences, and under each group its kinds
 * with the tools they happened on and where to see them in Traces.
 *
 * An occurrence is one finding (the tries of one streak are one). The rate is
 * the turns with at least one finding, of the window's closed turns. Shares
 * are of every occurrence in the window, so picking a group never changes
 * another group's share.
 */

/** Tools and examples listed per kind. */
export const KIND_TOOLS = 8;
export const KIND_EXAMPLES = 10;

export interface PageFinding {
  id: string;
  turnId: string;
  sessionId: string;
  stepOrdinal: number;
  eventId: string | null;
  kind: string;
  toolId: string;
  requestedToolId: string | null;
  repeats: number;
  worked: boolean;
  occurredAt: Date;
}

export interface KindTool {
  /** The tool that ran, and the one asked for when it differs. */
  toolId: string;
  requestedToolId: string | null;
  occurrences: number;
  /** Of those, the ones whose call still worked. */
  worked: number;
}

export interface KindExample {
  turnId: string;
  eventId: string | null;
  occurredAt: string;
}

export interface KindRow {
  kind: HallucinationKind;
  group: HallucinationGroup;
  occurrences: number;
  /** Of every occurrence in the window. */
  share: number;
  turns: number;
  sessions: number;
  /** Calls the occurrences cover: tries count. */
  calls: number;
  lastSeen: string;
  tools: KindTool[];
  moreTools: number;
  /** The newest occurrences, to open in Traces. */
  examples: KindExample[];
}

export interface GroupRow {
  group: HallucinationGroup;
  occurrences: number;
  share: number;
  turns: number;
  sessions: number;
  lastSeen: string | null;
  kinds: KindRow[];
  /** Why this group's rules had nothing to read in the window; null when it was checked. */
  unchecked: string | null;
}

/** What the window held for the rules to read (`page-queries.ts`, `loadCoverage`). */
export interface PageCoverage {
  requestedToolIds: boolean;
  errorText: boolean;
  replies: boolean;
  reactions: boolean;
}

/** Why a group could not be checked with what the project sends; null when it could. */
export function uncheckedReason(group: HallucinationGroup, coverage: PageCoverage): string | null {
  switch (group) {
    case "tool":
      return coverage.requestedToolIds || coverage.errorText
        ? null
        : "This project sends neither the tool name the agent asked for nor the text of its errors.";
    case "input":
      return coverage.errorText ? null : "This project's errors carry no text, only their type.";
    case "completion":
      return coverage.replies
        ? null
        : "This project sends no agent replies, so no claim that work was done can be read.";
  }
}

export interface HallucinationsPageInput {
  projectId: string;
  windowDays: WindowDays;
  findings: readonly PageFinding[];
  /** Closed turns that ended in the window. */
  turns: number;
  /** When the reading last ran; null when it never has. */
  lastReadAt: Date | null;
  capped: boolean;
  /** What the window held to read. Absent: everything (every group checked). */
  coverage?: PageCoverage;
  /** Names the last reading took for aliases, not findings. */
  aliases?: readonly StoredAlias[];
  /** The tool check by name, loaded only where the rules have nothing to read for tools. */
  toolNames?: ToolNameCheck | null;
}

export interface HallucinationsPageModel {
  projectId: string;
  windowDays: WindowDays;
  /** `not_read`: the reading has not run for this project yet. `empty`: no turns in the window. */
  state: "ready" | "empty" | "not_read" | "unavailable";
  query: HallucinationsQuery;
  totals: { turns: number; turnsAffected: number; rate: number | null; occurrences: number };
  /** Every group, in their fixed order; one with no occurrence has no kinds. */
  groups: GroupRow[];
  lastReadAt: string | null;
  capped: boolean;
  /** Names the runtime steadily maps to a tool: left out of the findings as naming mismatches. */
  aliases: StoredAlias[];
  /** How tools were checked when the rules had nothing to read: by name. Null: the rules checked them, or nothing could. */
  toolNames: ToolNameCheck | null;
}

const share = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);
const latest = (findings: readonly PageFinding[]): Date | null =>
  findings.reduce<Date | null>(
    (last, finding) => (last === null || finding.occurredAt > last ? finding.occurredAt : last),
    null,
  );
const distinct = <T>(values: readonly T[]): number => new Set(values).size;

function kindRow(
  kind: HallucinationKind,
  findings: readonly PageFinding[],
  total: number,
): KindRow {
  const byTool = new Map<string, KindTool>();
  for (const finding of findings) {
    const key = `${finding.requestedToolId ?? ""}>${finding.toolId}`;
    const seen = byTool.get(key) ?? {
      toolId: finding.toolId,
      requestedToolId: finding.requestedToolId,
      occurrences: 0,
      worked: 0,
    };
    byTool.set(key, {
      ...seen,
      occurrences: seen.occurrences + 1,
      worked: seen.worked + (finding.worked ? 1 : 0),
    });
  }
  const tools = [...byTool.values()].sort(
    (a, b) =>
      b.occurrences - a.occurrences ||
      a.toolId.localeCompare(b.toolId) ||
      (a.requestedToolId ?? "").localeCompare(b.requestedToolId ?? ""),
  );
  const newest = [...findings].sort(
    (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || a.id.localeCompare(b.id),
  );
  return {
    kind,
    group: GROUP_OF[kind],
    occurrences: findings.length,
    share: share(findings.length, total),
    turns: distinct(findings.map((finding) => finding.turnId)),
    sessions: distinct(findings.map((finding) => finding.sessionId)),
    calls: findings.reduce((sum, finding) => sum + finding.repeats, 0),
    lastSeen: latest(findings)!.toISOString(),
    tools: tools.slice(0, KIND_TOOLS),
    moreTools: Math.max(0, tools.length - KIND_TOOLS),
    examples: newest.slice(0, KIND_EXAMPLES).map((finding) => ({
      turnId: finding.turnId,
      eventId: finding.eventId,
      occurredAt: finding.occurredAt.toISOString(),
    })),
  };
}

export function buildHallucinationsPage(
  input: HallucinationsPageInput,
  query: HallucinationsQuery,
): HallucinationsPageModel {
  // A kind a later version writes and this page does not know is left out rather than failing the page.
  const findings = input.findings.filter((finding) => kindOf(finding.kind) !== null);
  const total = findings.length;
  const groups = HALLUCINATION_GROUPS.map((group): GroupRow => {
    const inGroup = findings.filter((finding) => GROUP_OF[kindOf(finding.kind)!] === group);
    const kinds = HALLUCINATION_KINDS.filter((kind) => GROUP_OF[kind] === group)
      .map((kind) => ({ kind, of: inGroup.filter((finding) => finding.kind === kind) }))
      .filter((entry) => entry.of.length > 0)
      .map((entry) => kindRow(entry.kind, entry.of, total))
      .sort((a, b) => b.occurrences - a.occurrences || a.kind.localeCompare(b.kind));
    return {
      group,
      occurrences: inGroup.length,
      share: share(inGroup.length, total),
      turns: distinct(inGroup.map((finding) => finding.turnId)),
      sessions: distinct(inGroup.map((finding) => finding.sessionId)),
      lastSeen: latest(inGroup)?.toISOString() ?? null,
      kinds,
      // A group with findings was checked, whatever the coverage reads.
      unchecked:
        inGroup.length > 0 || (group === "tool" && (input.toolNames?.callsOnWorking ?? 0) > 0)
          ? null
          : uncheckedReason(
              group,
              input.coverage ?? {
                requestedToolIds: true,
                errorText: true,
                replies: true,
                reactions: true,
              },
            ),
    };
  });
  const turnsAffected = distinct(findings.map((finding) => finding.turnId));
  return {
    projectId: input.projectId,
    windowDays: input.windowDays,
    state:
      input.lastReadAt === null && total === 0
        ? "not_read"
        : input.turns === 0 && total === 0
          ? "empty"
          : "ready",
    query,
    totals: {
      turns: input.turns,
      turnsAffected,
      rate: input.turns === 0 ? null : Math.min(1, turnsAffected / input.turns),
      occurrences: total,
    },
    groups,
    lastReadAt: input.lastReadAt?.toISOString() ?? null,
    capped: input.capped,
    aliases: [...(input.aliases ?? [])],
    toolNames: (input.toolNames?.callsOnWorking ?? 0) > 0 ? (input.toolNames ?? null) : null,
  };
}

/** The page when its rows could not be read. */
export function unavailableHallucinationsPage(
  projectId: string,
  windowDays: WindowDays,
  query: HallucinationsQuery,
): HallucinationsPageModel {
  return {
    projectId,
    windowDays,
    state: "unavailable",
    query,
    totals: { turns: 0, turnsAffected: 0, rate: null, occurrences: 0 },
    groups: HALLUCINATION_GROUPS.map((group) => ({
      group,
      occurrences: 0,
      share: 0,
      turns: 0,
      sessions: 0,
      lastSeen: null,
      kinds: [],
      unchecked: null,
    })),
    lastReadAt: null,
    capped: false,
    aliases: [],
    toolNames: null,
  };
}
