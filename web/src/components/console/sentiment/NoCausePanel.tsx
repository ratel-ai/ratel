"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import {
  NO_CAUSE_LABEL,
  NO_CAUSE_PEEK,
  percent,
  plural,
} from "@/components/console/sentiment/copy";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import { formatRelativeTime, formatTimestamp } from "@/lib/synthesis/traces/v2/format";
import type { DissatisfactionProblem } from "@/lib/views/traces/sentiment/overview";

/**
 * The unsatisfied turns no cause was named for, opened from What drives
 * dissatisfaction: what that means, how often, and where it happened (each
 * turn's date and the way to it in Traces), so the turns can be read by eye.
 */
export function NoCausePanel({
  projectId,
  problem,
  now,
}: {
  projectId: string;
  problem: DissatisfactionProblem | null;
  now: string;
}) {
  const peek = usePeek(NO_CAUSE_PEEK.param);
  const open = problem !== null && peek.id === NO_CAUSE_PEEK.id;
  return (
    <Panel
      open={open}
      onOpenChange={(next) => {
        if (!next) peek.close();
      }}
      title={NO_CAUSE_LABEL}
      subtitle="Unsatisfied turns"
    >
      {problem ? (
        <div className="flex flex-col gap-6" data-no-cause-panel="">
          <section className="flex flex-col gap-3" aria-label="What it is">
            <p className="text-sm text-fg">
              The person was not satisfied, and nothing named why: every call worked, or the trace
              showed nothing that went wrong. Open a turn to read what happened.
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
            <ul className="flex flex-col border-t border-line" data-no-cause-where="">
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
                    href={`/project/${encodeURIComponent(projectId)}/traces/turns/${encodeURIComponent(example.turnId)}`}
                    className={buttonVariants({ variant: "secondary", size: "sm" })}
                    data-no-cause-open-trace=""
                  >
                    Open in Traces
                    <ArrowUpRight aria-hidden />
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
