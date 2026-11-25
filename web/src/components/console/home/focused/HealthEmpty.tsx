import { EmptyScoreRing } from "@/components/console/health/v2/HealthScore";
import {
  EmptyAction,
  EmptyNoteLink,
  type EmptyWindow,
  TracesAction,
  WidgetEmpty,
} from "@/components/console/home/focused/WidgetEmpty";
import { fmtCount } from "@/lib/platform/format";
import type { FocusedHealth, HealthCard, NoScoreReason } from "@/lib/views/home/focused-load";
import { DATA_IS_MISSING } from "@/lib/views/home/no-score";

type NoScore = Extract<HealthCard, { kind: "state" }>;

/** The gauge without a score: an empty ring, why, and what makes a score. */
export function HealthEmpty({
  card,
  href,
  windowDays,
  at,
  note,
}: {
  card: NoScore;
  href: FocusedHealth["href"];
  windowDays: FocusedHealth["windowDays"];
  at: EmptyWindow;
  note?: string;
}) {
  const { title, description, traces } = copy(card, windowDays, at);
  const missing = DATA_IS_MISSING.has(card.reason);
  return (
    <WidgetEmpty
      name={`health-${card.reason}`}
      {...(missing ? { shape: "health" as const } : { figure: <EmptyScoreRing /> })}
      title={title}
      description={description}
      action={
        traces ? <TracesAction {...at} /> : <EmptyAction href={href}>Open Agent health</EmptyAction>
      }
      note={
        traces || note ? (
          <span className="flex flex-col items-center gap-1">
            {traces ? <EmptyNoteLink href={href}>Open Agent health</EmptyNoteLink> : null}
            {note}
          </span>
        ) : undefined
      }
    />
  );
}

/** `traces`: traces are what is missing. Only `first_reading` is being calculated. */
function copy(
  { reason, progress }: NoScore,
  days: number,
  { tracesSeen }: EmptyWindow,
): { title: string; description: string; traces: boolean } {
  const floor = fmtCount(progress?.floor ?? 0);
  const states: Record<
    Exclude<NoScoreReason, "failed">,
    { title: string; description: string; traces: boolean }
  > = {
    no_turns: {
      title: "No score yet",
      description:
        tracesSeen === "none"
          ? `A score needs ${floor} turns, and there are no traces yet. Send traces to get one.`
          : `A score needs ${floor} turns, and the last ${days} days have none. Send more traces.`,
      traces: true,
    },
    too_few: {
      title: "The score is not ready yet",
      description: `${fmtCount(progress?.turns ?? 0)} of the ${floor} turns a score needs. Send more traces.`,
      traces: true,
    },
    first_reading: {
      title: "Calculating the score",
      description:
        "Your first reading is being built. Send more traces to make the score more reliable.",
      traces: false,
    },
    no_tool_calls: {
      title: "No score yet",
      description: "No tool calls are recorded. Send traces with tool calls to get a score.",
      traces: true,
    },
    mixed_runs: {
      title: "No score yet",
      description: "Runs are mixed together. Send traces with turn ids to get a score.",
      traces: true,
    },
    no_score: {
      title: "No score in this reading",
      description: "Agent health shows what this reading found.",
      traces: false,
    },
  };
  return reason === "failed" ? states.no_score : states[reason];
}
