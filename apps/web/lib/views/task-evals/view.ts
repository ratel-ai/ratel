import { SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import type { ScorerResult } from "@/lib/views/task-scorers/types";
import { healthIssueHref } from "@/lib/views/tasks/paths";

export interface TaskEvalRow {
  id: string;
  turnId: string;
  origin: "auto" | "issue" | "user";
  pinned: boolean;
  excluded: boolean;
  ask: string;
  name?: string;
  chips: (ScorerResult & { label: string })[];
  selectionReason: string;
  issueHref: string | null;
  runHref: string;
}

export interface TaskEvalRefresh {
  id: string;
  status: "queued" | "running" | "done" | "error";
}

interface RowInput {
  projectId: string;
  case: Pick<TaskEvalRow, "id" | "turnId" | "origin" | "pinned"> & {
    excludedAt: Date | null;
    selectionReason: string;
    testName?: string | null;
    testAsk?: string | null;
  };
  messages: unknown;
  fallbackAsk?: string | null;
  results: readonly ScorerResult[];
  issue?: { id: string; title: string } | null;
}

export function taskEvalRow(input: RowInput): TaskEvalRow {
  const row = input.case;
  const chips = input.results.map((result) => ({ ...result, label: SCORER_LABELS[result.kind] }));
  const reason = selectionReason(row.origin, chips, input.issue);
  return {
    id: row.id,
    turnId: row.turnId,
    origin: row.origin,
    pinned: row.pinned,
    excluded: row.excludedAt !== null,
    ...(row.testName ? { name: row.testName } : {}),
    ask:
      row.testAsk ??
      firstUserMessage(input.messages) ??
      (input.fallbackAsk?.trim() || "Ask not captured"),
    chips,
    selectionReason: reason,
    issueHref:
      row.origin === "issue" && input.issue
        ? healthIssueHref(input.projectId, input.issue.id)
        : null,
    runHref: `/project/${encodeURIComponent(input.projectId)}/traces/turns/${encodeURIComponent(row.turnId)}`,
  };
}

function selectionReason(
  origin: TaskEvalRow["origin"],
  chips: TaskEvalRow["chips"],
  issue: RowInput["issue"],
): string {
  if (origin === "user") return "Added by you";
  if (origin === "issue")
    return issue ? `Evidence of: ${issue.title}` : "Evidence of an unavailable issue";
  if (chips.length === 0) return "No enabled scorers";
  const failed = chips.filter((chip) => chip.status === "fail");
  if (failed.length > 0) return `Fails ${failed.map((chip) => chip.label).join(", ")}`;
  const measured = chips.filter((chip) => chip.status !== "skip").length;
  return measured === 0
    ? "Scorer results not measured"
    : measured === chips.length
      ? "Passes all enabled scorers"
      : "Passes measured scorers";
}

function firstUserMessage(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  const message = messages.find((message) => message?.role === "user");
  if (!message) return null;
  const content = message.content ?? message.parts;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part) => part?.type === "text")
            .map((part) => part.text ?? part.content ?? "")
            .join(" ")
        : "";
  return text.trim() || null;
}
