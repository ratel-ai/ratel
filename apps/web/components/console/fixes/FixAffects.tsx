"use client";

import { cn } from "@ratel/design-system/cn";
import { IntentPin, TaskPin, ToolPin } from "@ratel/design-system/entity";
import type { MouseEvent, ReactNode } from "react";
import type { FixSubject } from "@/lib/views/fixes/types";

/**
 * What a fix touches, as pins (DESIGN.md, The product's nouns): a tool in
 * mono with its wrench, a task with its color, an intent with its speech
 * mark. In the table a pin filters the list in place; in the Panel it opens
 * the tool on Catalog, the task's page or the intent on Intents.
 *
 * PRIVACY: names are text inside the pins, never attributes; an intent is
 * named from people's asks.
 */

type Param = "tool" | "task" | "topic";

const WORD: Readonly<Record<Param, string>> = { tool: "tool", task: "task", topic: "intent" };

/** Pins a row shows before "+N". */
const ROW_PINS = 2;

interface PinSpec {
  key: string;
  param: Param;
  value: string;
  pin: (className: string) => ReactNode;
}

/**
 * A row's pins, one line: the tools it changes (a task's steps are its task
 * when there are many), then the task when there is room, else what it is
 * about. The rest are counted.
 */
function rowPins(subject: FixSubject): { pins: PinSpec[]; more: number } {
  const tools = subject.tools.map(
    (tool): PinSpec => ({
      key: `tool:${tool.id}`,
      param: "tool",
      value: tool.id,
      pin: (className) => <ToolPin name={tool.label} className={className} />,
    }),
  );
  const tasks = subject.tasks.map(
    (task): PinSpec => ({
      key: `task:${task.id}`,
      param: "task",
      value: task.id,
      pin: (className) => <TaskPin name={task.label} slot={task.color} className={className} />,
    }),
  );
  const intents = subject.topics.map(
    (topic): PinSpec => ({
      key: `topic:${topic.id}`,
      param: "topic",
      value: topic.id,
      pin: (className) => <IntentPin name={topic.label} className={className} />,
    }),
  );
  if (tools.length === 0) {
    const context = [...tasks, ...intents];
    return { pins: context.slice(0, ROW_PINS), more: Math.max(0, context.length - ROW_PINS) };
  }
  // A long chain of steps is one task: its pin says more than three tool names cut short,
  // and the title already counts the steps. The Panel lists every tool.
  if (tools.length > ROW_PINS && tasks.length > 0) return { pins: [tasks[0]!], more: 0 };
  const shown = tools.slice(0, ROW_PINS);
  if (shown.length < ROW_PINS && tasks.length > 0) shown.push(tasks[0]!);
  return { pins: shown, more: Math.max(0, tools.length - ROW_PINS) };
}

const PIN_HOVER = "group-hover/pin:border-line-strong group-hover/pin:text-fg";

/** One table row's subject as pins on one line; a click filters the list to that tool, task or intent. */
export function AffectsPins({
  subject,
  hrefFor,
  onFilter,
}: {
  subject: FixSubject;
  hrefFor: (param: Param, value: string) => string;
  onFilter: (param: Param, value: string) => void;
}) {
  const { pins, more } = rowPins(subject);
  if (pins.length === 0) return <span className="text-fg-faint">Whole project</span>;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {pins.map((spec) => (
        <a
          key={spec.key}
          href={hrefFor(spec.param, spec.value)}
          onClick={(event: MouseEvent<HTMLAnchorElement>) => {
            if (
              event.defaultPrevented ||
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            onFilter(spec.param, spec.value);
          }}
          className="group/pin inline-flex max-w-full min-w-0 shrink rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <span className="sr-only">Show fixes for the {WORD[spec.param]} </span>
          {spec.pin(cn("max-w-full shrink", PIN_HOVER))}
        </a>
      ))}
      {more > 0 ? (
        <span className="shrink-0 text-xs text-fg-subtle tabular-nums">
          +{more}
          <span className="sr-only"> more {more === 1 ? "tool" : "tools"}</span>
        </span>
      ) : null}
    </span>
  );
}

/** The Panel's pins: every tool, task and intent the fix touches, each opening where it lives. */
export function AffectsLinks({ subject }: { subject: FixSubject }) {
  const pins = [
    ...subject.tools.map((tool) => (
      <ToolPin key={`tool:${tool.id}`} name={tool.label} href={tool.href} className="max-w-64" />
    )),
    ...subject.tasks.map((task) => (
      <TaskPin
        key={`task:${task.id}`}
        name={task.label}
        slot={task.color}
        href={task.href}
        className="max-w-64"
      />
    )),
    ...subject.topics.map((topic) => (
      <IntentPin
        key={`topic:${topic.id}`}
        name={topic.label}
        href={topic.href}
        className="max-w-64"
      />
    )),
  ];
  if (pins.length === 0)
    return <p className="text-ui text-fg-muted">The whole project, not one tool or task.</p>;
  return <div className="flex flex-wrap gap-1.5">{pins}</div>;
}
