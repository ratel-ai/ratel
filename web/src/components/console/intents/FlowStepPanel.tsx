"use client";

import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { DotMeter } from "@ratel/design-system/dot-matrix";
import { IntentPin, NounIcon, TaskPin, ToolPin } from "@ratel/design-system/entity";
import { Panel } from "@ratel/design-system/panel";
import { StatRow } from "@ratel/design-system/stat-row";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { type FlowTopics, startLabel } from "@/components/console/intents/flow-topics";
import { FLOW_KIND_ICON } from "@/components/console/intents/marks";
import { type ExamplesLoad, TopicExamples } from "@/components/console/intents/TopicExamples";
import type { FlowNode, FlowStats } from "@/lib/readings/topics/types";
import { flowTaskId, flowToolId, NEXT_OTHER, NEXT_RETRY } from "@/lib/readings/topics/types";
import {
  askOrdinal,
  type FlowChipKind,
  type FlowLayout,
} from "@/lib/views/intents/topics-flow-layout";
import { intentsRoot, toolCatalogHref } from "@/lib/views/intents/topics-view";
import { taskHref } from "@/lib/views/tasks/paths";

const n = (value: number) => value.toLocaleString("en-US");
const pct = (value: number) => `${Math.round(value * 100)}%`;
const SKILL = "skill:";
const ENDED = "ended";

function kindOf(key: string): FlowChipKind {
  if (key === NEXT_RETRY) return "retry";
  if (key === NEXT_OTHER) return "other";
  if (key === ENDED) return "ended";
  if (flowTaskId(key) !== null) return "task";
  if (flowToolId(key) !== null) return "tool";
  return "topic";
}

function keyLabel(key: string, topics: FlowTopics): string {
  const kind = kindOf(key);
  if (kind === "retry") return "Asked again";
  if (kind === "other") return "Other";
  if (kind === "ended") return "Ended";
  return startLabel(key, topics);
}

/** A step by its mark: an intent, a task or a tool as its pin, linking where it lives; the rest by icon and word. */
function StepMark({
  projectId,
  stepKey,
  topics,
}: {
  projectId: string;
  stepKey: string;
  topics: FlowTopics;
}) {
  const kind = kindOf(stepKey);
  const label = keyLabel(stepKey, topics);
  if (kind === "topic")
    return (
      <IntentPin
        name={label}
        href={`${intentsRoot(projectId)}?peek=${encodeURIComponent(stepKey)}`}
        className="justify-self-start"
      />
    );
  const task = flowTaskId(stepKey);
  if (task !== null)
    return (
      <TaskPin
        name={label}
        slot={topics[stepKey]?.slot ?? null}
        href={taskHref(projectId, task)}
        className="justify-self-start"
      />
    );
  const tool = flowToolId(stepKey);
  if (tool !== null) {
    const skill = tool.startsWith(SKILL);
    return (
      <ToolPin
        name={skill ? tool.slice(SKILL.length) : tool}
        kind={skill ? "skill" : "tool"}
        href={toolCatalogHref(projectId, tool)}
        className="justify-self-start"
      />
    );
  }
  const Icon = FLOW_KIND_ICON[kind];
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-ui text-fg-muted">
      <Icon aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0 text-fg-subtle" />
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * One step of the Flows, in a Panel: how many conversations were there and
 * how it went for them, the way to follow only them (a first ask), the tools
 * that ran at this step, example asks (read on open), where they went next,
 * and the way to the intent, task or tool.
 */
export function FlowStepPanel({
  projectId,
  layout,
  stats,
  view,
  starts,
  chipId,
  topics,
  loadExamples,
  onOpen,
  onClose,
  onFollow,
}: {
  projectId: string;
  layout: FlowLayout | null;
  stats: FlowStats;
  view: string;
  /** The first asks that can be followed. */
  starts: readonly string[];
  chipId: string | null;
  topics: FlowTopics;
  loadExamples: ExamplesLoad;
  onOpen: (id: string) => void;
  onClose: () => void;
  /** Follows only the conversations that started at a key (`all` for everyone). */
  onFollow: (key: string) => void;
}) {
  const chip = chipId ? (layout?.chips.find((item) => item.id === chipId) ?? null) : null;
  const node = chip
    ? (stats.columns
        .find((column) => column.position === chip.position)
        ?.nodes.find((item) => item.key === chip.key) ?? null)
    : null;
  const open = chip !== null && node !== null;
  const [shown, setShown] = useState<{
    position: number;
    node: FlowNode;
    columnSessions: number;
  } | null>(null);
  if (open && (shown?.node !== node || shown.position !== chip.position)) {
    setShown({
      position: chip.position,
      node,
      columnSessions:
        stats.columns.find((column) => column.position === chip.position)?.sessions ?? 0,
    });
  }
  const order =
    layout?.chips
      .filter((item) => item.kind !== "ended" && item.kind !== "went_on")
      .map((item) => item.id) ?? [];
  const index = chipId ? order.indexOf(chipId) : -1;
  const kind = shown ? kindOf(shown.node.key) : null;
  const Icon = kind ? FLOW_KIND_ICON[kind] : null;
  return (
    <Panel
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={
        shown && Icon ? (
          <span className="flex min-w-0 items-center gap-2">
            <Icon aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-fg-subtle" />
            <span className={cn("truncate", kind === "tool" && "font-mono")}>
              {keyLabel(shown.node.key, topics)}
            </span>
          </span>
        ) : (
          ""
        )
      }
      subtitle={
        shown
          ? `${askOrdinal(shown.position)}, ${n(shown.node.sessions)} ${shown.node.sessions === 1 ? "conversation" : "conversations"}`
          : undefined
      }
      onPrevious={index > 0 ? () => onOpen(order[index - 1]!) : undefined}
      onNext={index >= 0 && index < order.length - 1 ? () => onOpen(order[index + 1]!) : undefined}
    >
      {shown ? (
        <StepBody
          key={`${view}:${shown.position}:${shown.node.key}`}
          projectId={projectId}
          view={view}
          followable={shown.position === 1 && starts.includes(shown.node.key)}
          position={shown.position}
          node={shown.node}
          columnSessions={shown.columnSessions}
          topics={topics}
          loadExamples={loadExamples}
          onFollow={onFollow}
        />
      ) : null}
    </Panel>
  );
}

function StepBody({
  projectId,
  view,
  followable,
  position,
  node,
  columnSessions,
  topics,
  loadExamples,
  onFollow,
}: {
  projectId: string;
  view: string;
  followable: boolean;
  position: number;
  node: FlowNode;
  columnSessions: number;
  topics: FlowTopics;
  loadExamples: ExamplesLoad;
  onFollow: (key: string) => void;
}) {
  const kind = kindOf(node.key);
  const nextTotal = node.next.reduce((sum, next) => sum + next.sessions, 0) + node.ended;
  const then = [
    ...node.next.map((next) => ({ key: next.key, sessions: next.sessions })),
    ...(node.ended > 0 ? [{ key: ENDED, sessions: node.ended }] : []),
  ].sort((a, b) => b.sessions - a.sessions);
  const following = view === node.key;
  return (
    <div className="flex flex-col gap-6" data-panel-kind="flow-step">
      <StatRow
        stats={[
          {
            label: "Conversations",
            value: n(node.sessions),
            hint: `${pct(node.sessions / Math.max(1, columnSessions))} of ${askOrdinal(position)}s`,
          },
          {
            label: "Unanswered",
            value: n(node.unanswered),
            hint: `of ${n(node.sessions)}`,
            trend: (
              <DotMeter
                value={node.unanswered / Math.max(1, node.sessions)}
                cells={10}
                tone={node.unanswered * 2 > node.sessions ? "warning" : "neutral"}
                label={`Unanswered ${pct(node.unanswered / Math.max(1, node.sessions))}`}
              />
            ),
          },
          {
            label: "Ended here",
            value: n(node.ended),
            hint: `${pct(node.ended / Math.max(1, node.sessions))} of them`,
          },
        ]}
      />

      {followable ? (
        <div className="flex flex-wrap items-center gap-2">
          {following ? (
            <Button variant="secondary" size="sm" onClick={() => onFollow("all")}>
              Show everyone
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={() => onFollow(node.key)}>
              <NounIcon noun="flow" className="text-current" />
              Follow these conversations
            </Button>
          )}
        </div>
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
          <NounIcon noun="tool" />
          Tools at this step
        </h3>
        {node.tools.length === 0 ? (
          <p className="text-ui text-fg-muted">No tool ran at this step.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {node.tools.map((tool) => {
              const share = tool.calls > 0 ? tool.failures / tool.calls : 0;
              const skill = tool.id.startsWith(SKILL);
              return (
                <li
                  key={tool.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto_7rem] items-center gap-3"
                >
                  <ToolPin
                    name={skill ? tool.id.slice(SKILL.length) : tool.id}
                    kind={skill ? "skill" : "tool"}
                    href={toolCatalogHref(projectId, tool.id)}
                    className="justify-self-start"
                  />
                  <span className="text-xs text-fg-muted tabular-nums">{n(tool.calls)} calls</span>
                  <span
                    className={cn(
                      "inline-flex items-center justify-end gap-1.5 text-xs tabular-nums",
                      tool.failures > 0 ? "text-fg" : "text-fg-faint",
                    )}
                  >
                    {tool.failures > 0 ? (
                      <>
                        <span aria-hidden className="size-1.5 rounded-full bg-danger" />
                        {pct(share)} failed
                      </>
                    ) : (
                      "No failures"
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <TopicExamples target={{ kind: "step", view, position, key: node.key }} load={loadExamples} />

      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
          <NounIcon noun="flow" />
          Then
        </h3>
        <ul className="flex flex-col gap-1.5">
          {then.map((next) => (
            <li
              key={next.key}
              className="grid grid-cols-[minmax(0,1fr)_auto_2.5rem] items-center gap-3"
            >
              <StepMark projectId={projectId} stepKey={next.key} topics={topics} />
              <DotMeter
                value={next.sessions / Math.max(1, nextTotal)}
                cells={10}
                tone="neutral"
                label={`${pct(next.sessions / Math.max(1, nextTotal))} of these conversations`}
              />
              <span className="text-right text-xs text-fg-muted tabular-nums">
                {n(next.sessions)}
              </span>
            </li>
          ))}
        </ul>
        {node.sessions > nextTotal ? (
          <p className="text-xs text-fg-subtle">The rest went on past the steps drawn.</p>
        ) : null}
      </section>

      {kind === "topic" ? (
        <div>
          <Link
            href={`${intentsRoot(projectId)}?peek=${encodeURIComponent(node.key)}`}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <NounIcon noun="intent" className="text-current" />
            Open the intent
            <ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      ) : kind === "task" ? (
        <div>
          <Link
            href={taskHref(projectId, flowTaskId(node.key)!)}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <NounIcon noun="task" className="text-current" />
            Open the task
            <ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      ) : kind === "tool" ? (
        <div>
          <Link
            href={toolCatalogHref(projectId, flowToolId(node.key)!)}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <NounIcon noun="tool" className="text-current" />
            Open in Catalog
            <ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      ) : null}
    </div>
  );
}
