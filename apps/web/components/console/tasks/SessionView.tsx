import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { type Crumb, Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import { ArrowLeft, CircleX, Search } from "lucide-react";
import Link from "next/link";
import type { TraceTurnRow, TraceTurnStepRow } from "@/lib/ledger/schema";
import { turnTracesHref } from "@/lib/readings/trace-signals/view";
import { formatClock } from "@/lib/synthesis/traces/v2/format";
import { formatCount } from "@/lib/views/tasks/format";
import { sessionStep } from "@/lib/views/tasks/session";

export type SessionTurns = readonly { turn: TraceTurnRow; steps: readonly TraceTurnStepRow[] }[];

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
}: {
  projectId: string;
  sessionId: string;
  turns: SessionTurns;
  names: Record<string, string>;
  highlight?: readonly string[];
  crumbs: readonly Crumb[];
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
}: {
  projectId: string;
  sessionId: string;
  turns: SessionTurns;
  names: Record<string, string>;
  highlight?: readonly string[];
  backHref: string;
  backLabel: string;
}) {
  const marked = new Set(highlight);
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
          <div className="rounded-lg border border-line dot-grid-fade">
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
                <ol
                  className="flex flex-wrap items-center gap-1.5"
                  aria-label={`Turn ${index + 1} steps`}
                >
                  {steps.map((row, position) => {
                    const step = sessionStep(row, names);
                    const isMarked = step.toolId !== null && marked.has(step.toolId);
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
                          className={cn(
                            "inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-xs",
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
              </li>
            ))}
          </ol>
        )}
      </div>
    </Section>
  );
}
