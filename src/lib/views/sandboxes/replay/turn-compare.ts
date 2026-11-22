import { argsKey } from "../fakes/domain/fake";
import type { RunMetrics } from "../replay";
import type { ManifestTool, ToolMode, ToolSetting } from "../tools-state";
import { type RecordedToolCall, type TurnPath, turnPath } from "./session-source";

/**
 * The rules of a chat session replay and its two-arm compare (RC-1110, spec
 * §9), pure so the browser and the tests share them: the tool modes of a
 * replay, per turn the output diff and the tool call diff of the two arms,
 * whether an arm left the recorded path, and the per-arm totals.
 */

/** A tool call of a replayed run, as the run's events give it. */
export interface ReplayedCall {
  tool: string;
  args: unknown;
  mode: string | null;
  fakeSource?: string | null;
  result?: unknown;
  isError?: boolean;
  done?: boolean;
}

/** One arm of one replayed turn, as the browser tracks it. */
export interface ReplayArmTurn {
  /** queued, running, then the run's end status. */
  status: string;
  reply: string | null;
  calls: ReplayedCall[];
  metrics: RunMetrics | null;
  runId: string | null;
  traceId: string | null;
  error: string | null;
}

export type ToolCallChangeKind = "same" | "changed" | "added" | "removed";

/** One place in the two arms' tool calls: the same call, changed arguments, or a call only one arm made. */
export interface ToolCallChange {
  kind: ToolCallChangeKind;
  tool: string;
  baseline: unknown;
  candidate: unknown;
}

export interface TextPart {
  kind: "same" | "removed" | "added";
  text: string;
}

export interface ReplayArmTotals {
  turns: number;
  failed: number;
  diverged: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

/** Past this many words per side, the diff shows the two whole replies. */
const MAX_DIFF_WORDS = 600;
const FAILED = new Set(["error", "canceled", "rejected", "lost", "unknown"]);

/**
 * The tool modes of a replay run: every tool fake, so a recorded call answers
 * with its recorded result, unless the reviewer set a mode in the Tools panel.
 */
export function replayToolModes(
  tools: readonly ManifestTool[],
  settings: Readonly<Record<string, ToolSetting>>,
): Record<string, ToolMode> {
  return Object.fromEntries(tools.map((tool) => [tool.name, settings[tool.name]?.mode ?? "fake"]));
}

/**
 * Whether an ended turn left the recorded path, or null when there is nothing
 * to judge: the turn has not ended, or it failed before any tool call. A turn
 * that made an off-path call and then failed or was canceled is diverged; its
 * status stays as it is.
 */
export function armDivergence(
  recorded: readonly RecordedToolCall[],
  arm: Pick<ReplayArmTurn, "status" | "calls">,
): TurnPath | null {
  if (arm.status === "queued" || arm.status === "running") return null;
  if (arm.status !== "ok" && arm.calls.length === 0) return null;
  return turnPath(recorded, arm.calls);
}

/** Where a replayed arm's turn stands against the recorded turn. */
export function armPath(
  recorded: readonly RecordedToolCall[],
  arm: Pick<ReplayArmTurn, "calls">,
): TurnPath {
  return turnPath(recorded, arm.calls);
}

/**
 * The tool call diff of one turn, place by place: the same tool with the same
 * normalized arguments is "same", with other arguments "changed"; another
 * tool at a place counts as one removed and one added.
 */
export function toolCallDiff(
  baseline: readonly ReplayedCall[],
  candidate: readonly ReplayedCall[],
): ToolCallChange[] {
  const changes: ToolCallChange[] = [];
  for (let i = 0; i < Math.max(baseline.length, candidate.length); i += 1) {
    const a = baseline[i];
    const b = candidate[i];
    if (a && b && a.tool === b.tool) {
      changes.push({
        kind: argsKey(a.args) === argsKey(b.args) ? "same" : "changed",
        tool: a.tool,
        baseline: a.args,
        candidate: b.args,
      });
      continue;
    }
    if (a) changes.push({ kind: "removed", tool: a.tool, baseline: a.args, candidate: undefined });
    if (b) changes.push({ kind: "added", tool: b.tool, baseline: undefined, candidate: b.args });
  }
  return changes;
}

/** The reply diff of one turn, word by word: same, removed (baseline only) and added (candidate only) parts. */
export function replyDiff(
  baseline: string | null,
  candidate: string | null,
): { same: boolean; parts: TextPart[] } {
  const a = baseline ?? "";
  const b = candidate ?? "";
  if (a === b) return { same: true, parts: a ? [{ kind: "same", text: a }] : [] };
  const left = words(a);
  const right = words(b);
  if (left.length > MAX_DIFF_WORDS || right.length > MAX_DIFF_WORDS) {
    return {
      same: false,
      parts: [
        ...(a ? [{ kind: "removed" as const, text: a }] : []),
        ...(b ? [{ kind: "added" as const, text: b }] : []),
      ],
    };
  }
  return { same: false, parts: merge(lcsDiff(left, right)) };
}

/** Per arm: turns done and failed, turns off the recorded path (failed ones too), and the summed tokens, cost and latency. */
export function replayTotals(
  arms: readonly ReplayArmTurn[],
  recorded: readonly (readonly RecordedToolCall[])[],
): ReplayArmTotals {
  const totals: ReplayArmTotals = {
    turns: 0,
    failed: 0,
    diverged: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMs: 0,
  };
  arms.forEach((arm, index) => {
    if (FAILED.has(arm.status)) totals.failed += 1;
    if (armDivergence(recorded[index] ?? [], arm)?.diverged) totals.diverged += 1;
    if (arm.status !== "ok") return;
    totals.turns += 1;
    if (!arm.metrics) return;
    totals.inputTokens += arm.metrics.inputTokens;
    totals.outputTokens += arm.metrics.outputTokens;
    totals.costUsd = Math.round((totals.costUsd + arm.metrics.costUsd) * 1e6) / 1e6;
    totals.latencyMs += arm.metrics.latencyMs ?? 0;
  });
  return totals;
}

/** Words with the space after each, so the parts join back into the text. */
function words(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

function lcsDiff(a: readonly string[], b: readonly string[]): TextPart[] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        a[i]!.trim() === b[j]!.trim()
          ? table[(i + 1) * cols + j + 1]! + 1
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }
  const parts: TextPart[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]!.trim() === b[j]!.trim()) {
      parts.push({ kind: "same", text: b[j]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      parts.push({ kind: "removed", text: a[i]! });
      i += 1;
    } else {
      parts.push({ kind: "added", text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) parts.push({ kind: "removed", text: a[i++]! });
  while (j < b.length) parts.push({ kind: "added", text: b[j++]! });
  return parts;
}

function merge(parts: readonly TextPart[]): TextPart[] {
  const out: TextPart[] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (last && last.kind === part.kind) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
}
