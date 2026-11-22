import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { type Crumb, Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import {
  TASK_COLOR_CLASSES,
  TASK_COLOR_SLOTS,
  type TaskColorSlot,
} from "@ratel/design-system/task-colors";
import { ArrowLeft, CircleX, Search } from "lucide-react";
import Link from "next/link";
import type { TraceTurnRow, TraceTurnStepRow } from "@/lib/ledger/schema";
import { turnTracesHref } from "@/lib/readings/trace-signals/view";
import { formatClock } from "@/lib/synthesis/traces/v2/format";
import { formatCount } from "@/lib/views/tasks/format";
import {
  type BandSegment,
  type SegmentBand,
  segmentBands,
  sessionStep,
} from "@/lib/views/tasks/session";

export type SessionTurns = readonly { turn: TraceTurnRow; steps: readonly TraceTurnStepRow[] }[];

/** A task segment of the session with its task's name (typed steps). */
export type SessionBand = BandSegment & { label: string };

/**
 * One session, turn by turn (Tool craft's drill-down, now opened from a
 * task's example runs): each turn a row, its searches and tool calls left to
 * right in the order they happened. The task's steps (`?tools=a,b`) are
 * marked, so the eye lands on where the task ran in the conversation.
 */
export function SessionView({
  sessionId,
  turns,
  names,
  highlight = [],
  crumbs,
  backHref,
  backLabel,
  projectId,
  bands = [],
}: {
  projectId: string;
  sessionId: string;
  turns: SessionTurns;
  names: Record<string, string>;
  highlight?: readonly string[];
  crumbs: readonly Crumb[];
  /** One band per task segment over the steps, read by kind. */
  bands?: readonly SessionBand[];
  /** The task the reader came from, or Tasks. */
  backHref: string;
  backLabel: string;
}) {
  return (
    <Page>
      <PageHeader
        title="Session"
        crumbs={crumbs}
        description={
          highlight.length > 0
            ? "Every closed turn of this session, its searches and tool calls in order; the task's steps are marked."
            : "Every closed turn of this session, its searches and tool calls in order."
        }
      />
      <PageBody>
        <SessionTimeline
          projectId={projectId}
          sessionId={sessionId}
          turns={turns}
          names={names}
          highlight={highlight}
          backHref={backHref}
          backLabel={backLabel}
          bands={bands}
        />
      </PageBody>
    </Page>
  );
}

export function SessionTimeline({
  projectId,
  sessionId,
  turns,
  names,
  highlight = [],
  backHref,
  backLabel,
  bands = [],
}: {
  projectId: string;
  sessionId: string;
  turns: SessionTurns;
  names: Record<string, string>;
  highlight?: readonly string[];
  backHref: string;
  backLabel: string;
  bands?: readonly SessionBand[];
}) {
  const marked = new Set(highlight);
  const tasks = taskBands(turns, bands);
  return (
    <Section
      title={
        turns.length === 0
          ? "Turns"
          : `${formatCount(turns.length)} ${turns.length === 1 ? "turn" : "turns"}`
      }
      description={
        <code translate="no" className="font-mono text-xs text-fg-subtle">
          {sessionId}
        </code>
      }
    >
      <div data-task-session={sessionId}>
        {turns.length === 0 ? (
          <div className="rounded-lg border border-line dot-grid-backdrop">
            <EmptyState
              emblem
              title="No closed turns"
              description="This session has no closed turns left, or they have been pruned."
              action={
                <Link href={backHref} className={buttonVariants({ variant: "secondary" })}>
                  <ArrowLeft aria-hidden className="size-3.5" />
                  {backLabel}
                </Link>
              }
            />
          </div>
        ) : (
          <ol className="flex flex-col">
            {turns.map(({ turn, steps }, index) => (
              <li
                key={turn.id}
                className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-4 border-b border-line py-3 last:border-b-0"
                data-turn={turn.id}
              >
                <div className="flex flex-col">
                  <span className="text-ui font-medium text-fg">Turn {index + 1}</span>
                  <span className="text-xs text-fg-subtle tabular-nums">
                    {formatClock(turn.startedAt, true)} UTC
                  </span>
                  <Link
                    href={turnTracesHref(projectId, turn.id)}
                    className="mt-0.5 self-start rounded text-xs text-fg-muted underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    Open in Traces
                  </Link>
                </div>
                <div className="flex min-w-0 flex-col gap-2">
                  {tasks.bands.length > 0 ? <TurnTasks turnId={turn.id} tasks={tasks} /> : null}
                  <ol
                    className="flex flex-wrap items-center gap-1.5"
                    aria-label={`Turn ${index + 1} steps`}
                  >
                    {steps.map((row, position) => {
                      const step = sessionStep(row, names);
                      const isMarked = step.toolId !== null && marked.has(step.toolId);
                      const band = tasks.byStep.get(`${turn.id}:${row.ordinal}`);
                      return (
                        <li key={step.key} className="flex items-center gap-1.5">
                          {position > 0 ? (
                            <span aria-hidden className="h-px w-2 bg-line-strong" />
                          ) : null}
                          <span
                            title={step.title}
                            data-step-kind={row.kind}
                            data-step-outcome={row.outcome ?? undefined}
                            data-step-marked={isMarked ? "true" : undefined}
                            data-step-task={band?.workflowId}
                            className={cn(
                              "inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-xs",
                              band &&
                                cn(
                                  "border-b-2",
                                  TASK_COLOR_CLASSES[tasks.colors.get(band.workflowId) ?? "neutral"]
                                    .border,
                                ),
                              step.kind === "search"
                                ? "border-dashed border-line-strong text-fg-muted"
                                : step.failed
                                  ? "border-danger/40 bg-danger-subtle font-mono text-danger"
                                  : "border-line bg-raised font-mono text-fg",
                              isMarked && "border-accent-mark bg-accent-subtle",
                            )}
                          >
                            {step.kind === "search" ? (
                              <Search aria-hidden className="size-3" />
                            ) : null}
                            {step.failed ? <CircleX aria-hidden className="size-3" /> : null}
                            {step.label}
                            {step.failed ? <span className="sr-only">, failed</span> : null}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Section>
  );
}

interface TaskBands {
  bands: readonly (SegmentBand & { label: string; turnIds: readonly string[] })[];
  /** The band of each step, by `<turn id>:<ordinal>`. */
  byStep: ReadonlyMap<string, SegmentBand>;
  colors: ReadonlyMap<string, TaskColorSlot>;
}

/** The session's task bands over its steps, the band of each step and one color per task in the order the session meets them. */
function taskBands(turns: SessionTurns, segments: readonly SessionBand[]): TaskBands {
  const positions = turns.flatMap(({ turn, steps }) =>
    steps.map((step) => ({ turnId: turn.id, ordinal: step.ordinal })),
  );
  const labels = new Map(segments.map((segment) => [segment.id, segment.label]));
  const bands = segmentBands(positions, segments).map((band) => ({
    ...band,
    label: labels.get(band.segmentId) ?? "Task",
    turnIds: [
      ...new Set(positions.slice(band.first, band.last + 1).map((position) => position.turnId)),
    ],
  }));
  const byStep = new Map<string, SegmentBand>();
  const colors = new Map<string, TaskColorSlot>();
  for (const band of bands) {
    for (const position of positions.slice(band.first, band.last + 1))
      byStep.set(`${position.turnId}:${position.ordinal}`, band);
    if (!colors.has(band.workflowId) && colors.size < TASK_COLOR_SLOTS.length)
      colors.set(band.workflowId, TASK_COLOR_SLOTS[colors.size]!);
  }
  return { bands, byStep, colors };
}

/** The tasks a turn takes part in, each saying when it began in an earlier turn or goes on in a later one. */
function TurnTasks({ turnId, tasks }: { turnId: string; tasks: TaskBands }) {
  const here = tasks.bands.filter((band) => band.turnIds.includes(turnId));
  if (here.length === 0) return null;
  return (
    <ul aria-label="Tasks in this turn" className="flex flex-wrap items-center gap-1.5">
      {here.map((band) => {
        const color = TASK_COLOR_CLASSES[tasks.colors.get(band.workflowId) ?? "neutral"];
        return (
          <li
            key={band.segmentId}
            data-turn-task={band.workflowId}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-md border-l-2 px-2 text-xs text-fg",
              color.bgSubtle,
              color.border,
            )}
          >
            <span className="truncate">{band.label}</span>
            {band.turnIds[0] !== turnId ? (
              <span className="text-fg-subtle">· from an earlier turn</span>
            ) : null}
            {band.turnIds.at(-1) !== turnId ? (
              <span className="text-fg-subtle">· goes on in the next turn</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
