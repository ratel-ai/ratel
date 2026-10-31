import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { DotMeter } from "@ratel/design-system/dot-matrix";
import { IntentPin, type Noun, NounIcon, ToolPin } from "@ratel/design-system/entity";
import { PeekLink } from "@ratel/design-system/panel";
import { Section } from "@ratel/design-system/section";
import { Tooltip } from "@ratel/design-system/tooltip";
import {
  Activity,
  ArrowRight,
  CircleCheck,
  MessageSquareQuote,
  Search,
  SquareArrowOutUpRight,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  CORRECTION_ICONS,
  EXAMPLE_STATUS_ICONS,
  FIX_KIND_ICONS,
  issueIcon,
  KindIcon,
} from "@/components/console/tasks/kind-icons";
import { StepPins } from "@/components/console/tasks/StepPins";
import { turnTracesHref } from "@/lib/readings/trace-signals/view";
import { formatRelativeTime, formatTimestamp } from "@/lib/synthesis/traces/v2/format";
import { collapseRepeats, EXAMPLE_STATUS_LABEL } from "@/lib/views/tasks/examples";
import { formatCount, formatMs, formatPer100, formatShare, plural } from "@/lib/views/tasks/format";
import type {
  ExampleRef,
  FixView,
  IssueView,
  TaskDetailModel,
  TaskTopic,
} from "@/lib/views/tasks/model";
import {
  issuePeek,
  selfCorrectionsHref,
  taskSessionHref,
  topicHref,
} from "@/lib/views/tasks/paths";
import type { ExampleRun } from "@/lib/views/tasks/queries";

/**
 * The parts of a task's page after its steps, each compact and visual: its
 * self-corrections as one strip of counts, its issues and fixes as rows with
 * a kind mark, the intents it serves as pins with their share, and example
 * runs as their calls in pins. Sentences wait one click away (an issue's
 * panel). Each part says plainly when it has nothing yet and links to its
 * neighbour page. Request text appears only in the example runs, read when
 * the page shows them, and only as text.
 */

const QUIET = "text-ui text-fg-muted";
const ROWS = "flex flex-col rounded-lg border border-line";
const ROW = "border-b border-line last:border-b-0";

/** A section title with its noun's mark and, when given, a count. */
export function NounTitle({
  noun,
  icon,
  count,
  children,
}: {
  noun?: Noun;
  icon?: ReactNode;
  count?: number;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {noun ? <NounIcon noun={noun} /> : icon}
      {children}
      {count !== undefined && count > 0 ? (
        <span className="font-normal text-fg-subtle tabular-nums">{formatCount(count)}</span>
      ) : null}
    </span>
  );
}

function SeeAll({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={buttonVariants({ variant: "ghost", size: "sm" })}>
      {children}
      <ArrowRight aria-hidden className="size-3.5" />
    </Link>
  );
}

/* - Self-corrections ---------------------------------------------------------- */

/** One strip: how often per 100 runs, then each kind that happened as an icon and a count; the strip opens the Self-corrections page on this task. */
export function CorrectionsStrip({
  projectId,
  taskId,
  corrections,
}: {
  projectId: string;
  taskId: string;
  corrections: TaskDetailModel["corrections"];
}) {
  const href = selfCorrectionsHref(projectId, { task: taskId });
  const happened = corrections?.rows.filter((row) => row.count > 0) ?? [];
  return (
    <section
      aria-labelledby="task-corrections"
      data-task-corrections={corrections?.source ?? "none"}
    >
      <Link
        href={href}
        className="group flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-line px-4 py-3 outline-none transition-colors duration-120 hover:border-line-strong hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
      >
        <h2 id="task-corrections" className="text-sm font-semibold text-fg">
          <NounTitle noun="selfCorrection">Self-corrections</NounTitle>
        </h2>
        {corrections === null ? (
          <span className={QUIET}>Not measured yet</span>
        ) : (
          <>
            <span className="text-ui text-fg-muted">
              <span className="font-semibold text-fg tabular-nums">
                {formatPer100(corrections.per100)}
              </span>{" "}
              per 100 runs
            </span>
            {happened.length === 0 ? (
              <span className={cn(QUIET, "inline-flex items-center gap-1.5")}>
                <CircleCheck aria-hidden strokeWidth={1.5} className="size-3.5 text-success" />
                None in this window
              </span>
            ) : (
              <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
                {happened.map((row) => (
                  <li
                    key={row.kind}
                    className="inline-flex items-center gap-1.5 text-ui"
                    data-correction-kind={row.kind}
                  >
                    <KindIcon icon={CORRECTION_ICONS[row.kind]} />
                    <span className="text-fg tabular-nums">{formatCount(row.count)}</span>
                    <span className="text-fg-muted">{row.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <ArrowRight
          aria-hidden
          className="ml-auto size-3.5 shrink-0 text-fg-subtle transition-colors duration-120 group-hover:text-fg"
        />
      </Link>
    </section>
  );
}

/* - Issues -------------------------------------------------------------------- */

/** Each issue as one row: its kind's mark, its title (opening its panel), the tools it is about, its number and what to do. */
export function IssuesList({ issues }: { issues: readonly IssueView[] }) {
  return (
    <div id="issues" className="scroll-mt-20">
      <Section
        title={
          <NounTitle noun="issue" count={issues.length}>
            Issues
          </NounTitle>
        }
      >
        {issues.length === 0 ? (
          <p className={cn(QUIET, "flex items-center gap-2")}>
            <CircleCheck aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-success" />
            No open issue on this task or its tools.
          </p>
        ) : (
          <ul className={ROWS} data-task-issues={issues.length}>
            {issues.map((issue) => (
              <li
                key={issue.id}
                className={cn(
                  ROW,
                  "grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-1.5 sm:grid-cols-[auto_minmax(0,1fr)_9rem_9.5rem]",
                )}
                data-task-issue={issue.kind}
                data-issue-family={issue.family}
              >
                <KindIcon icon={issueIcon(issue)} className="text-fg-muted" />
                <span className="flex min-w-0 items-center gap-2">
                  <PeekLink
                    peek={issuePeek(issue.id)}
                    className="min-w-0 truncate rounded-sm text-ui font-medium text-fg outline-none underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {issue.title}
                  </PeekLink>
                  {issue.tools.length > 0 ? (
                    <span className="hidden min-w-0 shrink items-center gap-1 md:flex">
                      {issue.tools.slice(0, 2).map((tool) => (
                        <ToolPin key={tool.id} name={tool.label} className="h-5 max-w-60 px-1" />
                      ))}
                    </span>
                  ) : null}
                </span>
                <span className="flex items-baseline justify-end gap-1.5 text-right whitespace-nowrap">
                  <span className="text-ui font-medium text-fg tabular-nums">
                    {issue.figure.display}
                  </span>
                  <span className="hidden text-xs text-fg-subtle sm:inline">
                    {issue.figure.caption}
                  </span>
                </span>
                {issue.action ? (
                  <Link
                    href={issue.action.href}
                    className={cn(
                      buttonVariants({ variant: "secondary", size: "sm" }),
                      "col-start-3 justify-self-end max-sm:mt-1 sm:col-start-auto sm:justify-self-start",
                    )}
                    data-issue-action={issue.action.kind}
                  >
                    {issue.action.label}
                  </Link>
                ) : (
                  <span aria-hidden className="hidden sm:block" />
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/* - Fixes --------------------------------------------------------------------- */

/** Each fix as one row: its kind's mark and name, and the tools it changes; the row opens it. */
export function FixesList({ fixes, allHref }: { fixes: readonly FixView[]; allHref: string }) {
  return (
    <Section
      title={
        <NounTitle noun="fix" count={fixes.length}>
          Fixes
        </NounTitle>
      }
      actions={<SeeAll href={allHref}>All fixes</SeeAll>}
      className="min-w-0"
    >
      {fixes.length === 0 ? (
        <p className={QUIET}>No fix for this task yet.</p>
      ) : (
        <ul className={ROWS} data-task-fixes={fixes.length}>
          {fixes.map((fix) => (
            <li key={fix.id} className={ROW}>
              <Link
                href={fix.href}
                className="group flex min-h-11 items-center gap-3 rounded-lg px-3 py-1.5 text-ui outline-none transition-colors duration-120 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
                data-task-fix={fix.id}
                data-fix-kind={fix.kind}
              >
                <KindIcon icon={FIX_KIND_ICONS[fix.kind]} className="text-fg-muted" />
                <span className="shrink-0 font-medium text-fg group-hover:underline underline-offset-2">
                  {fix.kindLabel}
                </span>
                {fix.tools.length > 0 ? (
                  // A phone keeps the row to its kind; the fix itself names its tools.
                  <StepPins
                    steps={fix.tools.map((tool) => ({ key: tool.id, label: tool.label }))}
                    max={2}
                    ordered={false}
                    label="Tools it changes"
                    className="min-w-0 max-sm:hidden"
                  />
                ) : null}
                <ArrowRight aria-hidden className="ml-auto size-3.5 shrink-0 text-fg-subtle" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/* - Intents ------------------------------------------------------------------- */

const INTENTS_SHOWN = 8;

/** The intents its runs serve, as pins with the share of its runs in each. */
export function IntentsList({
  projectId,
  topics,
  runs,
}: {
  projectId: string;
  topics: readonly TaskTopic[] | null;
  runs: number;
}) {
  const more = topics ? topics.length - INTENTS_SHOWN : 0;
  return (
    <Section
      title={
        <NounTitle noun="intent" count={topics?.length}>
          Intents it serves
        </NounTitle>
      }
      className="min-w-0"
    >
      {topics === null ? (
        <p className={QUIET}>
          Not measured yet. Intents appear once people&apos;s asks are grouped.
        </p>
      ) : topics.length === 0 ? (
        <p className={QUIET}>None of its runs fell in an intent.</p>
      ) : (
        <ul className="flex flex-col gap-1.5" data-task-topics={topics.length}>
          {topics.slice(0, INTENTS_SHOWN).map((topic) => {
            const share = runs > 0 ? Math.min(1, topic.runs / runs) : 0;
            return (
              <li
                key={topic.id}
                className="flex min-w-0 items-center gap-3"
                data-task-topic={topic.id}
              >
                <IntentPin
                  name={topic.name}
                  href={topicHref(projectId, topic.id)}
                  className="min-w-0 shrink"
                />
                <span className="ml-auto flex shrink-0 items-center gap-2">
                  <DotMeter
                    value={share}
                    cells={10}
                    tone="neutral"
                    label={`${formatShare(share)} of its runs`}
                    className="max-sm:hidden"
                  />
                  <span className="w-10 text-right text-xs text-fg-muted tabular-nums">
                    {formatShare(share)}
                  </span>
                </span>
              </li>
            );
          })}
          {more > 0 ? (
            <li className="text-xs text-fg-subtle tabular-nums">
              {plural(more, "more intent", "more intents")}
            </li>
          ) : null}
        </ul>
      )}
    </Section>
  );
}

/* - Example runs -------------------------------------------------------------- */

const LINK_SMALL =
  "inline-flex items-center gap-1 rounded-sm text-xs text-fg-muted outline-none underline-offset-2 hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-focus";

/** Each example run as one row: how it ended, its calls as pins, how long it took and when, and the way into Traces. */
export function ExampleRuns({
  projectId,
  taskId,
  examples,
  runs,
  focusTools,
  now,
}: {
  projectId: string;
  taskId: string;
  examples: readonly ExampleRef[];
  runs: ReadonlyMap<string, ExampleRun>;
  focusTools: readonly string[];
  now: Date;
}) {
  return (
    <Section
      title={
        <NounTitle
          icon={
            <Activity aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0 text-fg-subtle" />
          }
        >
          Example runs
        </NounTitle>
      }
    >
      {examples.length === 0 ? (
        <p className={QUIET}>No example runs kept for this window.</p>
      ) : (
        <ul className={ROWS} data-task-examples={examples.length}>
          {examples.map((example) => (
            <ExampleRow
              key={example.turnId}
              projectId={projectId}
              taskId={taskId}
              example={example}
              run={runs.get(example.turnId)}
              focusTools={focusTools}
              now={now}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

function ExampleRow({
  projectId,
  taskId,
  example,
  run,
  focusTools,
  now,
}: {
  projectId: string;
  taskId: string;
  example: ExampleRef;
  run: ExampleRun | undefined;
  focusTools: readonly string[];
  now: Date;
}) {
  const status = run?.status ?? (example.why === "failed" ? "failed" : null);
  const mark = status ? EXAMPLE_STATUS_ICONS[status] : null;
  // One line from md: how it ended, its calls, when, the way in. On a phone:
  // how it ended and when on top, then its calls, then the way in.
  return (
    <li
      className={cn(
        ROW,
        "flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5 md:flex-nowrap",
      )}
      data-task-example={example.why}
      data-example-status={status ?? undefined}
    >
      <span className="order-1 inline-flex shrink-0 items-center gap-1.5 text-xs text-fg-muted md:w-24">
        {mark && status ? (
          <>
            <mark.icon
              aria-hidden
              strokeWidth={1.5}
              className={cn("size-3.5 shrink-0", mark.tone)}
            />
            {EXAMPLE_STATUS_LABEL[status]}
          </>
        ) : null}
      </span>
      <span className="order-3 flex min-w-0 basis-full flex-col gap-1 md:order-2 md:flex-1 md:basis-auto">
        {run && run.steps.length > 0 ? (
          <StepPins
            steps={collapseRepeats(run.steps).map((group, index) => ({
              key: `${index}:${group.toolId}`,
              label: group.label,
              failed: group.failed,
              count: group.count,
            }))}
            max={4}
            label="Its calls, in order"
          />
        ) : (
          <span className="text-xs text-fg-subtle tabular-nums">
            {run ? plural(run.calls, "call", "calls") : "Run details not kept"}
          </span>
        )}
        {run?.ask ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
            {run.ask.source === "search" ? (
              <Search aria-hidden strokeWidth={1.5} className="size-3 shrink-0 text-fg-subtle" />
            ) : (
              <MessageSquareQuote
                aria-hidden
                strokeWidth={1.5}
                className="size-3 shrink-0 text-fg-subtle"
              />
            )}
            <span className="truncate">{run.ask.text}</span>
          </span>
        ) : null}
      </span>
      {run ? (
        <span className="order-2 ml-auto flex shrink-0 items-center gap-3 text-xs whitespace-nowrap text-fg-subtle tabular-nums md:order-3 md:ml-0">
          <span>{formatMs(run.endedAt.getTime() - run.startedAt.getTime())}</span>
          <time dateTime={run.startedAt.toISOString()} title={formatTimestamp(run.startedAt)}>
            {formatRelativeTime(run.startedAt, now)}
          </time>
        </span>
      ) : null}
      <span className="order-4 flex shrink-0 items-center gap-2 whitespace-nowrap">
        <Link
          href={turnTracesHref(projectId, example.turnId, example.focusEventId)}
          className={LINK_SMALL}
        >
          <SquareArrowOutUpRight aria-hidden className="size-3" />
          Open in Traces
        </Link>
        {run ? (
          <Tooltip content="Open the conversation">
            <Link
              href={taskSessionHref(projectId, run.sessionId, { tools: focusTools, task: taskId })}
              className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "-my-1.5")}
              aria-label="Open the conversation"
            >
              <NounIcon noun="conversation" className="size-3.5 text-fg-muted" />
            </Link>
          </Tooltip>
        ) : null}
      </span>
    </li>
  );
}
