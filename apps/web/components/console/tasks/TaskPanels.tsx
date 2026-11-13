"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { DotMeter } from "@ratel/design-system/dot-matrix";
import { NounIcon, TaskPin, ToolPin } from "@ratel/design-system/entity";
import { Panel, usePeek } from "@ratel/design-system/panel";
import type { TaskColorSlot } from "@ratel/design-system/task-colors";
import { Flag, Timer } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { CORRECTION_ICONS, issueIcon, KindIcon } from "@/components/console/tasks/kind-icons";
import { formatCount, formatMs, formatShare } from "@/lib/views/tasks/format";
import type { IssueView, StepView } from "@/lib/views/tasks/model";
import {
  catalogToolHref,
  fixesHref,
  healthIssueHref,
  issuePeek,
  parseTaskPeek,
  selfCorrectionsHref,
  stepPeek,
} from "@/lib/views/tasks/paths";

/**
 * The task page's one Panel: a step's numbers (`?peek=step:<tool>`) or an
 * issue's sentences (`?peek=issue:<id>`), the detail the page keeps off its
 * face. `j` and `k` move to the next step or issue. The task's color rides in
 * the panel as its pin. Names and numbers only; nothing a person wrote.
 */
export function TaskPanels({
  projectId,
  taskId,
  taskName,
  color,
  steps,
  sideSteps,
  issues,
  hasReading,
}: {
  projectId: string;
  taskId: string;
  taskName: string;
  color: TaskColorSlot | null;
  steps: readonly StepView[];
  sideSteps: readonly StepView[];
  issues: readonly IssueView[];
  hasReading: boolean;
}) {
  const peek = usePeek();
  const allSteps = [...steps, ...sideSteps];
  const find = (id: string | null) => {
    const target = parseTaskPeek(id);
    if (target?.kind === "step") {
      const index = allSteps.findIndex((step) => step.toolId === target.id);
      return index >= 0 ? { kind: "step" as const, index, step: allSteps[index]! } : null;
    }
    if (target?.kind === "issue") {
      const index = issues.findIndex(
        (issue) => issue.id === target.id || issue.aliases.includes(target.id),
      );
      return index >= 0 ? { kind: "issue" as const, index, issue: issues[index]! } : null;
    }
    return null;
  };
  const current = find(peek.id);
  // Keep the last item while the panel animates out.
  const [lastId, setLastId] = useState<string | null>(current ? peek.id : null);
  if (current && peek.id !== lastId) setLastId(peek.id);
  const shown = current ?? find(lastId);

  const move = (direction: 1 | -1) => {
    if (!current) return;
    const list =
      current.kind === "step"
        ? allSteps.map((step) => stepPeek(step.toolId))
        : issues.map((issue) => issuePeek(issue.id));
    const next = list[current.index + direction];
    if (next) peek.open(next);
  };

  const task = <TaskPin name={taskName} slot={color} className="max-w-60" />;
  let title: ReactNode = "";
  let subtitle: ReactNode;
  let body: ReactNode = null;
  if (shown?.kind === "step") {
    const { step } = shown;
    title = <span className="font-mono">{step.label}</span>;
    subtitle =
      step.position !== null
        ? `Step ${step.position} of ${steps.length}`
        : step.role === "helper"
          ? "A helper some runs add"
          : "A tool some runs add";
    body = (
      <StepPanelBody
        projectId={projectId}
        taskId={taskId}
        step={step}
        task={task}
        hasReading={hasReading}
      />
    );
  } else if (shown?.kind === "issue") {
    const { issue } = shown;
    title = issue.title;
    subtitle = issue.onTask
      ? issue.tools.length > 0
        ? "On this task and its tools"
        : "On this task"
      : issue.tools.length === 1
        ? "On one of its tools"
        : "On its tools";
    body = <IssuePanelBody projectId={projectId} issue={issue} task={task} />;
  }

  return (
    <Panel
      open={current !== null}
      onOpenChange={(next) => {
        if (!next) peek.close();
      }}
      title={title}
      subtitle={subtitle}
      onPrevious={() => move(-1)}
      onNext={() => move(1)}
    >
      {body}
    </Panel>
  );
}

const PANEL_LINK = buttonVariants({ variant: "ghost", size: "sm" });

/** A fact in the panel's grid: a label over a number. */
function Fact({ label, children, icon }: { label: string; children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-line px-3 py-2">
      <dt className="flex items-center gap-1.5 text-xs text-fg-subtle">
        {icon}
        {label}
      </dt>
      <dd className="text-sm font-medium text-fg tabular-nums">{children}</dd>
    </div>
  );
}

/** A step's numbers, what came next, and its neighbours. */
export function StepPanelBody({
  projectId,
  taskId,
  step,
  task,
  hasReading,
}: {
  projectId: string;
  taskId: string;
  step: StepView;
  task: ReactNode;
  hasReading: boolean;
}) {
  return (
    <div className="flex flex-col gap-5" data-task-panel="step" data-step={step.toolId}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui text-fg-muted">
        {task}
        {hasReading ? (
          <span>
            called in <span className="text-fg tabular-nums">{formatShare(step.runShare)}</span> of
            its runs
          </span>
        ) : null}
      </p>
      {hasReading ? (
        <>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Fact label="Calls">{formatCount(step.calls)}</Fact>
            <Fact label="Fails">
              <span className="inline-flex items-center gap-2">
                {formatShare(step.failureShare)}
                <span className="text-xs font-normal text-fg-subtle">
                  {formatCount(step.failures)}
                </span>
              </span>
            </Fact>
            <Fact label="Typical time" icon={<KindIcon icon={Timer} className="size-3" />}>
              {formatMs(step.medianMs)}
            </Fact>
            <Fact label="Then waits">{formatMs(step.handoffMs)}</Fact>
            <Fact
              label="Retried"
              icon={<KindIcon icon={CORRECTION_ICONS.retry_after_error} className="size-3" />}
            >
              {formatCount(step.retries)}
            </Fact>
            <Fact
              label="Switched tools"
              icon={<KindIcon icon={CORRECTION_ICONS.switch_after_error} className="size-3" />}
            >
              {formatCount(step.switches)}
            </Fact>
            <Fact
              label="Gave up"
              icon={<KindIcon icon={CORRECTION_ICONS.gave_up_after_error} className="size-3" />}
            >
              {formatCount(step.gaveUp)}
            </Fact>
          </dl>
          {step.next.length > 0 ? (
            <section aria-labelledby="step-next" className="flex flex-col gap-2">
              <h3 id="step-next" className="text-xs font-medium text-fg-subtle">
                Then
              </h3>
              <ul className="flex flex-col gap-1.5" data-step-next="">
                {step.next.map((next) => (
                  <li key={next.toolId ?? "end"} className="flex min-w-0 items-center gap-3">
                    {next.toolId === null ? (
                      <span className="inline-flex h-6 items-center gap-1.5 text-xs text-fg-muted">
                        <Flag aria-hidden strokeWidth={1.5} className="size-3.5 text-fg-subtle" />
                        {next.label}
                      </span>
                    ) : (
                      <ToolPin name={next.label} className="min-w-0 shrink" />
                    )}
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                      <DotMeter
                        value={next.share}
                        cells={10}
                        tone="neutral"
                        label={`${formatShare(next.share)} of the time`}
                      />
                      <span className="w-10 text-right text-xs text-fg-muted tabular-nums">
                        {formatShare(next.share)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : (
        <p className="text-ui text-fg-muted">Its numbers arrive with the next reading.</p>
      )}
      <nav
        aria-label="This step elsewhere"
        className="flex flex-wrap gap-1 border-t border-line pt-3"
      >
        <Link
          href={selfCorrectionsHref(projectId, { tool: step.toolId, task: taskId })}
          className={PANEL_LINK}
        >
          <NounIcon noun="selfCorrection" />
          Self-corrections
        </Link>
        <Link href={fixesHref(projectId, { tool: step.toolId })} className={PANEL_LINK}>
          <NounIcon noun="fix" />
          Fixes
        </Link>
        <Link href={catalogToolHref(projectId, step.toolId)} className={PANEL_LINK}>
          <NounIcon noun={step.toolId.startsWith("skill:") ? "skill" : "tool"} />
          Catalog
        </Link>
      </nav>
    </div>
  );
}

/** An issue's number, what it is about, its sentences and what to do. */
export function IssuePanelBody({
  projectId,
  issue,
  task,
}: {
  projectId: string;
  issue: IssueView;
  task: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5" data-task-panel="issue" data-issue={issue.id}>
      <div className="flex items-center gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-line bg-raised">
          <KindIcon icon={issueIcon(issue)} className="size-4 text-fg-muted" />
        </span>
        <p className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tracking-tight text-fg tabular-nums">
            {issue.figure.display}
          </span>
          <span className="text-xs text-fg-subtle">{issue.figure.caption}</span>
        </p>
      </div>
      <p className="flex flex-wrap items-center gap-2">
        {issue.onTask ? task : null}
        {issue.tools.map((tool) => (
          <ToolPin
            key={tool.id}
            name={tool.label}
            href={catalogToolHref(projectId, tool.id)}
            className="max-w-60"
          />
        ))}
      </p>
      <p className="text-sm text-fg">{issue.claim}</p>
      <section aria-labelledby="issue-fix" className="flex flex-col gap-1">
        <h3 id="issue-fix" className="flex items-center gap-1.5 text-xs font-medium text-fg-subtle">
          <NounIcon noun="fix" className="size-3" />
          What to do
        </h3>
        <p className="text-sm text-fg-muted">{issue.fix}</p>
      </section>
      <div className={cn("flex flex-wrap items-center gap-2 border-t border-line pt-3")}>
        {issue.action ? (
          <Link
            href={issue.action.href}
            className={buttonVariants({ variant: "primary", size: "sm" })}
            data-issue-action={issue.action.kind}
          >
            {issue.action.label}
          </Link>
        ) : null}
        <Link href={healthIssueHref(projectId, issue.id)} className={PANEL_LINK}>
          <NounIcon noun="issue" />
          Open in Agent health
        </Link>
      </div>
    </div>
  );
}
