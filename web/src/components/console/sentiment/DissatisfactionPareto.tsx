import { cn } from "@ratel/design-system/cn";
import { PeekLink } from "@ratel/design-system/panel";
import { Section } from "@ratel/design-system/section";
import { Tooltip } from "@ratel/design-system/tooltip";
import { ChartBarDecreasing, ChevronRight } from "lucide-react";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import { CausePanel } from "@/components/console/sentiment/CausePanel";
import { NO_CAUSE_LABEL, percent, plural } from "@/components/console/sentiment/copy";
import { FoldGroup } from "@/components/console/sentiment/FoldGroup";
import type { PanelTurn } from "@/components/console/turn-panel/useTurnPanel";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import { CAUSE_PEEK, problemPeekId } from "@/lib/views/traces/sentiment/cause-peek";
import type { DissatisfactionProblem, Overview } from "@/lib/views/traces/sentiment/overview";
import {
  CAUSE_LABEL,
  CAUSE_MEANING,
  DISSATISFACTION_GROUP_LABEL,
  DISSATISFACTION_GROUP_MEANING,
  type DissatisfactionGroup,
  dissatisfactionGroupOf,
} from "@/lib/views/traces/sentiment/page-kinds";

/**
 * What drives dissatisfaction: the unsatisfied turns in three groups (the
 * agent, the system it runs on, other), each with its share, folded; opened,
 * a group lists its causes as a Pareto list (across every tool, most first,
 * ranked across all groups, with the running total). The causes outside the
 * fewest that add up to 80% are quieter. A cause opens its own
 * unsatisfied turns in the Panel.
 */
export function DissatisfactionPareto({
  projectId,
  dissatisfaction,
  now,
  turn,
}: {
  projectId: string;
  dissatisfaction: Overview["dissatisfaction"];
  /** The request's time, so relative times match between server and client. */
  now: string;
  /** The turn the address opens in the Panel. */
  turn: PanelTurn | null;
}) {
  const { turns, problems, vital, groups } = dissatisfaction;
  if (turns === 0) return null;
  const lead = problems.slice(0, vital);
  const reached = lead.at(-1)?.cumulative ?? 0;
  const most = Math.max(1, ...problems.map((problem) => problem.turns));
  return (
    <Section title={<NounTitle icon={ChartBarDecreasing}>What drives dissatisfaction</NounTitle>}>
      <p className="text-ui text-fg-muted" data-sentiment-pareto-summary="">
        <span className="font-semibold text-fg tabular-nums">
          {formatCount(vital)} of {plural(problems.length, "cause")}
        </span>{" "}
        {vital === 1 ? "is" : "are"} behind{" "}
        <span className="font-semibold text-fg tabular-nums">{percent(reached)}</span> of{" "}
        {plural(turns, "unsatisfied turn")}
        {lead[0] ? (
          <>
            . The largest,{" "}
            <span className={lead[0].cause ? "text-fg" : "text-fg-subtle"}>
              {problemLabel(lead[0])}
            </span>
            , alone is behind {percent(lead[0].share)}.
          </>
        ) : (
          "."
        )}
      </p>
      <ul className="flex flex-col border-t border-line" data-sentiment-pareto="">
        {groups
          .filter((total) => total.turns > 0)
          .map((total) => {
            const inGroup = problems.filter(
              (problem) => dissatisfactionGroupOf(problem.cause) === total.group,
            );
            return (
              <li key={total.group} className="border-b border-line">
                <FoldGroup
                  data-dissatisfaction-group={total.group}
                  headingClassName="grid cursor-pointer grid-cols-[1.5rem_minmax(10rem,22rem)_1fr_3rem_3.5rem_4rem] items-center gap-3 rounded-sm py-2 text-ui outline-none transition-colors duration-150 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus max-sm:grid-cols-[1.25rem_1fr_2.5rem_3.5rem]"
                  heading={
                    <>
                      <ChevronRight
                        aria-hidden
                        className="size-3.5 justify-self-end text-fg-subtle transition-transform duration-300 ease-out group-data-[open=true]/fold:rotate-90 motion-reduce:transition-none"
                      />
                      <Tooltip content={DISSATISFACTION_GROUP_MEANING[total.group]}>
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span
                            className={cn(
                              "truncate font-medium",
                              total.group === "other" ? "text-fg-muted" : "text-fg",
                            )}
                          >
                            {DISSATISFACTION_GROUP_LABEL[total.group]}
                          </span>
                          <span className="text-xs text-fg-subtle">
                            {plural(inGroup.length, "cause")}
                          </span>
                        </span>
                      </Tooltip>
                      <span
                        className="h-2.5 w-full rounded-[3px] bg-raised max-sm:hidden"
                        aria-hidden
                      >
                        <span
                          className={cn("block h-full rounded-[3px]", GROUP_BAR[total.group])}
                          style={{ width: `${Math.max(2, (total.turns / turns) * 100)}%` }}
                        />
                      </span>
                      <span className="text-right font-medium text-fg tabular-nums">
                        {formatCount(total.turns)}
                      </span>
                      <span className="text-right text-fg-muted tabular-nums">
                        {percent(total.share)}
                      </span>
                      <span className="max-sm:hidden" />
                    </>
                  }
                >
                  <ol className="flex flex-col pb-2 pl-4">
                    {inGroup.map((problem) => (
                      <Row
                        key={problem.key}
                        rank={problems.indexOf(problem) + 1}
                        problem={problem}
                        most={most}
                        quiet={!problem.vital}
                      />
                    ))}
                  </ol>
                </FoldGroup>
              </li>
            );
          })}
      </ul>
      <CausePanel projectId={projectId} problems={problems} now={now} turn={turn} />
    </Section>
  );
}

/** Each group's bar: the agent's in the danger colour, the system's in the warning colour, the rest grey. */
const GROUP_BAR: Record<DissatisfactionGroup, string> = {
  agent: "bg-danger",
  system: "bg-warning",
  other: "bg-fg-faint",
};

function problemLabel(problem: DissatisfactionProblem): string {
  return problem.cause ? CAUSE_LABEL[problem.cause] : NO_CAUSE_LABEL;
}

function Row({
  rank,
  problem,
  most,
  quiet = false,
}: {
  rank: number;
  problem: DissatisfactionProblem;
  most: number;
  quiet?: boolean;
}) {
  const label = (
    <span className="flex min-w-0 items-baseline gap-2">
      <span
        className={cn(
          "truncate",
          !problem.cause ? "text-fg-subtle" : quiet ? "text-fg-muted" : "text-fg",
        )}
      >
        {problemLabel(problem)}
      </span>
    </span>
  );
  return (
    <li
      className="grid grid-cols-[1.5rem_minmax(10rem,22rem)_1fr_3rem_3.5rem_4rem] items-center gap-3 border-b border-line py-1.5 text-ui max-sm:grid-cols-[1.25rem_1fr_2.5rem_3.5rem]"
      data-pareto-problem={problem.key || "none"}
    >
      <span className="text-right text-xs text-fg-subtle tabular-nums">{rank}</span>
      <Tooltip
        content={
          problem.cause
            ? CAUSE_MEANING[problem.cause]
            : "Unsatisfied turns where nothing in the trace or a model named what went wrong."
        }
      >
        {/* The cause's own unsatisfied turns, beside the list. */}
        <PeekLink
          peek={problemPeekId(problem)}
          param={CAUSE_PEEK}
          className="min-w-0 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
        >
          {label}
        </PeekLink>
      </Tooltip>
      <span className="h-2.5 w-full rounded-[3px] bg-raised max-sm:hidden" aria-hidden>
        <span
          className={cn(
            "block h-full rounded-[3px]",
            quiet || !problem.cause ? "bg-fg-faint" : "bg-danger",
          )}
          style={{ width: `${Math.max(2, (problem.turns / most) * 100)}%` }}
        />
      </span>
      <span className="text-right text-fg tabular-nums">{formatCount(problem.turns)}</span>
      <span className="text-right text-fg-muted tabular-nums">{percent(problem.share)}</span>
      <Tooltip content="Running total: this problem and every larger one">
        <span className="text-right text-xs text-fg-subtle tabular-nums max-sm:hidden">
          {percent(problem.cumulative)}
        </span>
      </Tooltip>
    </li>
  );
}
