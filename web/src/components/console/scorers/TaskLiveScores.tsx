"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import Link from "next/link";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";
import { newTaskScorerHref, scorersHref } from "@/lib/views/scorers/paths";
import type { TaskScorerScores } from "@/lib/views/scorers/task-scores";
import { KindBadge, summaryValue } from "./parts";
import { ScoreTrend } from "./ScoreTrend";

/** A task's live scoring: the scorers scoped to it, each with its trend. */
export function TaskLiveScores({
  projectId,
  taskId,
  scorers,
}: {
  projectId: string;
  taskId: string;
  scorers: readonly TaskScorerScores[];
}) {
  const add = (
    <Link
      href={newTaskScorerHref(projectId, taskId)}
      className={buttonVariants({ variant: "secondary" })}
    >
      Add scorer
    </Link>
  );
  return (
    <Section
      title="Live scores"
      description="The scorers of this task's traces, by day for the last 14 days (UTC)."
      actions={scorers.length > 0 ? add : undefined}
    >
      {scorers.length === 0 ? (
        <EmptyState
          emblem
          title="No scorers for this task yet"
          description="A scorer of this task gives each of its new traces one result."
          action={add}
        />
      ) : (
        <ul className="flex flex-col gap-8">
          {scorers.map((scorer) => (
            <li key={scorer.id} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="text-sm font-medium">
                  <Link
                    href={`${scorersHref(projectId)}/${scorer.id}`}
                    className="text-fg hover:underline"
                  >
                    {scorer.name}
                  </Link>
                </h3>
                <KindBadge kind={scorer.kind} />
                {scorer.enabled ? null : <span className="text-xs text-fg-subtle">Off</span>}
                <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">
                  {scorer.summary}
                </span>
                <span className="text-sm text-fg tabular-nums">{summaryValue(scorer)}</span>
                <span className="text-xs text-fg-subtle tabular-nums">
                  {`${formatInteger(scorer.week?.scored ?? 0)} scored, 7 days`}
                </span>
              </div>
              <ScoreTrend days={scorer.trend} verdict={scorer.verdict} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
