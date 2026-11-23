"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { NO_CAUSE_LABEL, percent, plural } from "@/components/console/sentiment/copy";
import { type PanelTurn, useTurnPanel } from "@/components/console/turn-panel/useTurnPanel";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import { turnTracesHref } from "@/lib/readings/trace-signals/view";
import { formatRelativeTime, formatTimestamp } from "@/lib/synthesis/traces/v2/format";
import { CAUSE_PEEK, openProblem, problemPeekId } from "@/lib/views/traces/sentiment/cause-peek";
import type { DissatisfactionProblem } from "@/lib/views/traces/sentiment/overview";
import { CAUSE_LABEL, CAUSE_MEANING } from "@/lib/views/traces/sentiment/page-kinds";

/**
 * One cause of dissatisfaction, opened from its row: what it means, how often
 * it is behind a turn someone was unsatisfied with, and those turns only
 * (never a turn nobody complained about), each opening in this same Panel.
 * `j` and `k` step through the causes.
 */
export function CausePanel({
  projectId,
  problems,
  now,
  turn,
}: {
  projectId: string;
  problems: readonly DissatisfactionProblem[];
  now: string;
  turn: PanelTurn | null;
}) {
  const peek = usePeek(CAUSE_PEEK);
  const problem = openProblem(problems, peek.id);
  const label = problem?.cause ? CAUSE_LABEL[problem.cause] : NO_CAUSE_LABEL;
  const panel = useTurnPanel({ turn, openId: peek.id, backLabel: label });
  const index = problem ? problems.indexOf(problem) : -1;
  const step = (by: 1 | -1) => {
    const next = problems[index + by];
    if (next) peek.open(problemPeekId(next));
  };
  return (
    <Panel
      open={problem !== null}
      onOpenChange={(next) => {
        if (!next) panel.close(CAUSE_PEEK);
      }}
      size={panel.inTurn ? "wide" : "default"}
      title={panel.inTurn ? panel.title : label}
      subtitle={panel.inTurn ? undefined : "Unsatisfied turns"}
      actions={panel.actions}
      onPrevious={!panel.inTurn && index > 0 ? () => step(-1) : undefined}
      onNext={
        !panel.inTurn && index >= 0 && index < problems.length - 1 ? () => step(1) : undefined
      }
    >
      {panel.inTurn ? (
        panel.body
      ) : problem ? (
        <div className="flex flex-col gap-6" data-cause-panel={problemPeekId(problem)}>
          <section className="flex flex-col gap-3" aria-label="What it is">
            <p className="text-sm text-fg">
              {problem.cause
                ? CAUSE_MEANING[problem.cause]
                : "The person was not satisfied, and nothing named why: every call worked, or the trace showed nothing that went wrong. Open a turn to read what happened."}
            </p>
            <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-ui">
              <dt className="text-fg-subtle">How often</dt>
              <dd className="flex flex-wrap items-baseline gap-x-2 text-fg">
                <span className="tabular-nums">{plural(problem.turns, "turn")}</span>
                <span className="text-fg-subtle tabular-nums">{`${percent(problem.share)} of unsatisfied turns`}</span>
              </dd>
            </dl>
          </section>
          <section className="flex flex-col gap-3" aria-label="Where it happened">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-semibold text-fg">Where it happened</h3>
              <span className="text-xs text-fg-subtle">
                {problem.turns > problem.examples.length
                  ? `The newest ${formatCount(problem.examples.length)} of ${plural(problem.turns, "turn")}`
                  : plural(problem.examples.length, "turn")}
              </span>
            </div>
            <ul className="flex flex-col border-t border-line" data-cause-where="">
              {problem.examples.map((example) => (
                <li
                  key={example.turnId}
                  className="flex min-h-10 items-center justify-between gap-3 border-b border-line"
                >
                  {example.endedAt ? (
                    <time
                      dateTime={example.endedAt}
                      title={formatRelativeTime(example.endedAt, now)}
                      className="text-ui text-fg tabular-nums"
                    >
                      {formatTimestamp(example.endedAt)}
                    </time>
                  ) : (
                    <span className="text-ui text-fg-subtle">No time sent</span>
                  )}
                  <Link
                    href={turnTracesHref(projectId, example.turnId)}
                    className={buttonVariants({ variant: "secondary", size: "sm" })}
                    data-cause-open-trace={example.turnId}
                    onClick={panel.onOpen({ turnId: example.turnId, eventId: null })}
                  >
                    Open in Traces
                    <ArrowRight aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </Panel>
  );
}
