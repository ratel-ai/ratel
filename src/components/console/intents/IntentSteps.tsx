import { cn } from "@ratel/design-system/cn";
import { Disclosure } from "@ratel/design-system/disclosure";
import { TaskPin } from "@ratel/design-system/entity";
import { Skeleton } from "@ratel/design-system/states";
import { ArrowRight, CornerDownRight, Footprints } from "lucide-react";
import { Fragment } from "react";
import { Block, n, pct, StoredToolPin } from "@/components/console/intents/panel-parts";
import {
  type IntentStepsView,
  pictureRows,
  type StepRow,
  type StepTool,
} from "@/lib/views/intents/topics-steps";
import type { IntentStepsRead } from "@/lib/views/intents/topics-steps-load";
import type { TopicView } from "@/lib/views/intents/topics-view";

/** Tools named on the "Sometimes also" and first-call lines at most. */
const LINE_TOOLS = 4;
/** Indents by depth in the picture, written out whole so the classes exist at build time. */
const DEPTH_INDENT = ["pl-0", "pl-0", "pl-5", "pl-10"] as const;

const STEPS_MARK = (
  <Footprints aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0 text-fg-subtle" />
);

type HrefOf = (toolId: string) => string | undefined;

/**
 * "Step by step" in an intent's panel (DESIGN.md: show, don't explain): the
 * tools most of its asks run, in their usual order, as pins; how many asks
 * run all of them and how often in that order; the task that runs these
 * steps, in its color; and the helpers left out. Every other way its asks go
 * (what they start with, what comes after each) sits behind one Details row,
 * each step with the share of the intent's asks that reach it that way.
 * Tool ids and numbers only.
 */
export function IntentSteps({ read, topic }: { read: IntentStepsRead; topic: TopicView }) {
  if (read.status === "none") return null;
  const order = read.status === "ready" ? orderNote(read.steps) : null;
  return (
    <Block mark={STEPS_MARK} title="Step by step" action={order}>
      {read.status === "failed" ? (
        <p className="text-ui text-fg-muted">
          Couldn&apos;t read its steps. Try again in a moment.
        </p>
      ) : (
        <StepsBody steps={read.steps} topic={topic} />
      )}
    </Block>
  );
}

/** How often the asks that run every step run them in this order, as a quiet note beside the title (as on a task). */
function orderNote(steps: IntentStepsView) {
  if (!steps.sentence || steps.sentence.tools.length < 2 || steps.sentence.together === 0)
    return null;
  return (
    <span className="text-xs text-fg-subtle tabular-nums">
      Same order in {pct(steps.sentence.inOrderShare)} of runs
    </span>
  );
}

function StepsBody({ steps, topic }: { steps: IntentStepsView; topic: TopicView }) {
  const hrefs = new Map(topic.tools.map((tool) => [tool.id, tool.href]));
  const hrefOf: HrefOf = (toolId) => hrefs.get(toolId);
  if (steps.withCalls === 0)
    return <p className="text-ui text-fg-muted">None of its asks called a tool.</p>;
  const rows = pictureRows(steps.picture);
  const drawn = new Set([
    ...(steps.sentence?.tools ?? []).map((tool) => tool.id),
    ...rows.map((row) => row.node.toolId),
  ]);
  const also = steps.also.filter((tool) => !drawn.has(tool.id)).slice(0, LINE_TOOLS);
  return (
    <div className="flex flex-col gap-3" data-intent-steps="">
      {steps.sentence ? (
        <div className="flex flex-col gap-1.5">
          <Chain tools={steps.sentence.tools} hrefOf={hrefOf} />
          <p className="text-xs text-fg-muted tabular-nums">
            {pct(steps.sentence.togetherShare)} of its asks run{" "}
            {steps.sentence.tools.length === 1 ? "it" : `all ${n(steps.sentence.tools.length)}`}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="text-ui text-fg-muted">No one tool runs in most of its asks.</p>
          <ToolLine
            label="They start with"
            tools={steps.firsts.slice(0, LINE_TOOLS)}
            hrefOf={hrefOf}
          />
        </div>
      )}
      <MatchedTask steps={steps} topic={topic} />
      <ToolLine
        label="In most asks, left out"
        tools={steps.helpers}
        hrefOf={hrefOf}
        shares={false}
      />
      <ToolLine label="Sometimes also" tools={also} hrefOf={hrefOf} />
      {rows.length > 1 ? (
        <Disclosure title="Every way it goes" hint={`${n(rows.length)} steps`}>
          <div className="flex flex-col gap-2">
            <Tree rows={rows} turns={steps.turns} hrefOf={hrefOf} />
            <p className="text-xs text-fg-subtle tabular-nums">
              Each share is of its {n(steps.turns)} asks.
            </p>
          </div>
        </Disclosure>
      ) : null}
    </div>
  );
}

/** The usual steps as pins joined by arrows; on a phone they wrap. */
function Chain({ tools, hrefOf }: { tools: readonly StepTool[]; hrefOf: HrefOf }) {
  return (
    <ol
      aria-label="Its usual steps, in order"
      className="flex min-w-0 flex-wrap items-center gap-1.5"
    >
      {tools.map((tool, index) => (
        <Fragment key={tool.id}>
          {index > 0 ? (
            <li aria-hidden className="flex shrink-0">
              <ArrowRight strokeWidth={1.5} className="size-3 text-fg-faint" />
            </li>
          ) : null}
          <li className="flex min-w-0 max-w-full">
            <StoredToolPin id={tool.id} href={hrefOf(tool.id)} className="text-fg" />
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

/** The task that runs these steps, in its color, with the share of the intent's asks it ran. */
function MatchedTask({ steps, topic }: { steps: IntentStepsView; topic: TopicView }) {
  if (!steps.task) return null;
  const task = topic.tasks.find((item) => item.id === steps.task!.id);
  if (!task) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted tabular-nums">
      <TaskPin name={task.name} slot={steps.task.color} href={task.href} />
      <span>
        runs {steps.task.exact ? "these steps" : "similar steps"} · {pct(steps.task.share)} of its
        asks
      </span>
    </p>
  );
}

/** A line of tools with a label in front: helpers, the occasional ones, or what asks start with. */
function ToolLine({
  label,
  tools,
  hrefOf,
  shares = true,
}: {
  label: string;
  tools: readonly StepTool[];
  hrefOf: HrefOf;
  shares?: boolean;
}) {
  if (tools.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-fg-subtle tabular-nums">
      <span>{label}</span>
      {tools.map((tool) => (
        <span key={tool.id} className="inline-flex min-w-0 max-w-full items-center gap-1.5">
          <StoredToolPin id={tool.id} href={hrefOf(tool.id)} />
          {shares ? <span>{pct(tool.share)}</span> : null}
        </span>
      ))}
    </div>
  );
}

/**
 * Every way its asks go: each tool under the one it comes after, with the
 * share of the intent's asks that reach it that way (a first call's asks, or
 * the asks that ran the step above before it).
 */
function Tree({
  rows,
  turns,
  hrefOf,
}: {
  rows: readonly StepRow[];
  turns: number;
  hrefOf: HrefOf;
}) {
  return (
    <ul aria-label="Every way its asks go" className="flex min-w-0 flex-1 flex-col gap-1">
      {rows.map(({ node, link }) => (
        <li
          key={node.key}
          className={cn(
            "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3",
            DEPTH_INDENT[Math.min(node.depth, DEPTH_INDENT.length - 1)],
          )}
          data-step-depth={node.depth}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {link.kind === "starts" ? (
              <ArrowRight aria-hidden strokeWidth={1.5} className="size-3 shrink-0 text-fg-faint" />
            ) : (
              <CornerDownRight
                aria-hidden
                strokeWidth={1.5}
                className="size-3 shrink-0 text-fg-faint"
              />
            )}
            <span className="sr-only">{link.kind === "starts" ? "Starts with" : "Then"}</span>
            <StoredToolPin
              id={node.toolId!}
              href={hrefOf(node.toolId!)}
              className={node.main ? "text-fg" : undefined}
            />
          </span>
          <span className="text-xs text-fg-muted tabular-nums">
            {pct(turns === 0 ? 0 : link.together / turns)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** While the panel's detail is read: the block's place, held. */
export function IntentStepsLoading() {
  return (
    <section aria-busy="true" className="flex flex-col gap-2">
      <h3 className="flex min-h-7 items-center gap-1.5 text-sm font-semibold text-fg">
        {STEPS_MARK}
        Step by step
      </h3>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-4 w-1/3" />
      </div>
    </section>
  );
}
