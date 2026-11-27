"use client";

import { Checkbox } from "@ratel/design-system/checkbox";
import { Callout } from "@ratel/design-system/states";
import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type { RecentTurn } from "@/lib/views/evals/recent-turns";
import { evalsApi, send } from "./request";

/**
 * The trace picker: the newest closed turns of the project, each with its ask (when the project
 * lets Ratel read captured text), its task and its time. A chosen turn becomes a row with a frozen
 * copy of its input and tool fixtures.
 */
export function TracePicker({
  projectId,
  tasks,
  chosen,
  onChange,
}: {
  projectId: string;
  tasks: ReadonlyArray<{ id: string; name: string }>;
  chosen: readonly string[];
  onChange: (turnIds: string[]) => void;
}) {
  const [turns, setTurns] = useState<RecentTurn[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [now] = useState(() => new Date().toISOString());
  useEffect(() => {
    let live = true;
    void send<{ turns: RecentTurn[] }>("GET", `${evalsApi(projectId)}/recent-turns`).then(
      (answer) => {
        if (!live) return;
        if (answer.ok) setTurns(answer.data.turns);
        else setProblem(answer.message);
      },
    );
    return () => {
      live = false;
    };
  }, [projectId]);
  if (problem) return <Callout tone="danger">{problem}</Callout>;
  if (!turns) return <p className="text-ui text-fg-muted">Reading the newest traces…</p>;
  if (turns.length === 0) {
    return <p className="text-ui text-fg-muted">The project has no closed trace yet.</p>;
  }
  const names = new Map(tasks.map(({ id, name }) => [id, name]));
  const withheld = turns.every(({ ask }) => ask === null);
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-xs font-medium text-fg-muted">
        Newest traces{chosen.length > 0 ? ` · ${chosen.length} chosen` : ""}
      </legend>
      {withheld ? (
        <p className="text-xs text-fg-subtle">
          The project does not let Ratel read captured text: a trace shows no ask, and it cannot
          become a row.
        </p>
      ) : null}
      <ul className="flex max-h-60 flex-col overflow-y-auto rounded-md border border-line">
        {turns.map((turn) => (
          <li key={turn.turnId} className="border-b border-line px-3 py-1.5 last:border-b-0">
            <Checkbox
              className="w-full min-w-0"
              checked={chosen.includes(turn.turnId)}
              disabled={withheld}
              onCheckedChange={(on) =>
                onChange(
                  on ? [...chosen, turn.turnId] : chosen.filter((one) => one !== turn.turnId),
                )
              }
              label={
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-fg">
                    {turn.ask ?? `Turn ${turn.turnId.slice(0, 8)}`}
                  </span>
                  <span className="text-xs text-fg-subtle">
                    {formatRelativeTime(turn.endedAt, now)}
                    {turn.taskId ? ` · ${names.get(turn.taskId) ?? turn.taskId}` : ""}
                    {` · ${turn.tools} ${turn.tools === 1 ? "tool" : "tools"}`}
                    {turn.failed ? " · failed" : ""}
                  </span>
                </span>
              }
            />
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
