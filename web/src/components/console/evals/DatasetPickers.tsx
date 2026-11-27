"use client";

import { Badge } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { Checkbox } from "@ratel/design-system/checkbox";
import { Callout } from "@ratel/design-system/states";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { PickerTurn } from "@/lib/views/evals/adapters/turn-picker";
import { shortText } from "@/lib/views/evals/dataset-pages";
import type { DatasetQuery } from "@/lib/views/evals/domain/dataset";
import { turnHref } from "@/lib/views/evals/paths";

type PreviewRow = { turnId: string; input: string; output: string | null };
type Preview =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; rows: PreviewRow[]; found: number }
  | { state: "failed"; message: string };

/** The newest closed turns of the project, to choose as rows. Each links to its trace turn. */
export function TurnPicker({
  projectId,
  turns,
  chosen,
  onChange,
  now,
}: {
  projectId: string;
  turns: readonly PickerTurn[];
  chosen: readonly string[];
  onChange: (turnIds: string[]) => void;
  now: string;
}) {
  if (turns.length === 0) {
    return <p className="text-sm text-fg-subtle">This project has no closed trace yet.</p>;
  }
  const toggle = (turnId: string, on: boolean) =>
    onChange(on ? [...chosen, turnId] : chosen.filter((id) => id !== turnId));
  return (
    <ul
      aria-label="Traces"
      className="max-h-64 divide-y divide-line overflow-y-auto rounded-md border border-line"
    >
      {turns.map((turn) => (
        <li key={turn.turnId} className="flex items-center gap-3 px-3 py-2 text-ui">
          <Checkbox
            aria-label={`Choose the trace of ${turn.taskName ?? "no task"}, ${formatRelativeTime(turn.endedAt, now)}, ${turn.turnId.slice(0, 8)}`}
            checked={chosen.includes(turn.turnId)}
            onCheckedChange={(on) => toggle(turn.turnId, on)}
          />
          <span className="w-24 shrink-0 text-fg-muted" title={turn.endedAt}>
            {formatRelativeTime(turn.endedAt, now)}
          </span>
          <span className="min-w-0 flex-1 truncate text-fg">
            {turn.taskName ?? <span className="text-fg-faint">No task</span>}
          </span>
          {turn.failed ? <Badge tone="danger">Failed</Badge> : null}
          <Link
            href={turnHref(projectId, turn.turnId)}
            target="_blank"
            className="shrink-0 text-xs text-fg-subtle hover:text-fg hover:underline"
          >
            Trace
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * What a query resolves now, at most ten rows. A run resolves it again when it starts and freezes
 * its rows, so the rows of a run can differ.
 */
export function QueryPreview({
  projectId,
  query,
  auto = false,
}: {
  projectId: string;
  /** Null while the query is not complete. */
  query: DatasetQuery | null;
  /** Loads the preview at once, with no button. */
  auto?: boolean;
}) {
  const [preview, setPreview] = useState<Preview>({ state: "idle" });
  const queryKey = query ? JSON.stringify({ query }) : null;

  const load = useCallback(async () => {
    if (!queryKey) return;
    setPreview({ state: "loading" });
    setPreview(await fetchPreview(projectId, queryKey));
  }, [projectId, queryKey]);

  useEffect(() => {
    if (auto) void load();
  }, [auto, load]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={load} disabled={!query || preview.state === "loading"}>
          {preview.state === "loading" ? "Resolving…" : "Preview"}
        </Button>
        {preview.state === "done" ? (
          <span className="text-xs text-fg-subtle">
            {preview.found === 1
              ? "It finds 1 trace now."
              : `It finds ${preview.found} traces now.`}{" "}
            {preview.rows.length < preview.found ? `The first ${preview.rows.length} show.` : null}
          </span>
        ) : null}
      </div>
      {preview.state === "failed" ? (
        <Callout tone="danger" title="The query does not resolve">
          {preview.message}
        </Callout>
      ) : null}
      {preview.state === "done" && preview.rows.length > 0 ? (
        <ul
          aria-label="Preview"
          className="divide-y divide-line rounded-md border border-line text-ui"
        >
          {preview.rows.map((row) => (
            <li key={row.turnId} className="flex items-start gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-fg">{shortText(row.input)}</span>
                {row.output ? (
                  <span className="block truncate text-xs text-fg-subtle">
                    {shortText(row.output)}
                  </span>
                ) : null}
              </span>
              <Link
                href={turnHref(projectId, row.turnId)}
                target="_blank"
                className="shrink-0 text-xs text-fg-subtle hover:text-fg hover:underline"
              >
                Trace
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

async function fetchPreview(projectId: string, body: string): Promise<Preview> {
  try {
    const response = await fetch(`/api/projects/${projectId}/evals/datasets/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const answer = (await response.json().catch(() => ({}))) as {
      rows?: PreviewRow[];
      found?: number;
      message?: string;
    };
    if (!response.ok) return { state: "failed", message: answer.message ?? "Try again." };
    return { state: "done", rows: answer.rows ?? [], found: answer.found ?? 0 };
  } catch {
    return { state: "failed", message: "Try again." };
  }
}
