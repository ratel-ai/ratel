"use client";

import { Badge } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { DotMeter, DotSpark } from "@ratel/design-system/dot-matrix";
import { NounIcon, TaskPin } from "@ratel/design-system/entity";
import { Panel } from "@ratel/design-system/panel";
import { type StatProps, StatRow } from "@ratel/design-system/stat-row";
import { ArrowUpRight, Flag, MoreHorizontal, RotateCcw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AlsoWants, AskFor, AskForLoading } from "@/components/console/intents/IntentBreakdown";
import { IntentSteps, IntentStepsLoading } from "@/components/console/intents/IntentSteps";
import {
  Block,
  IntentButton,
  n,
  pct,
  Share,
  StoredToolPin,
} from "@/components/console/intents/panel-parts";
import { SentimentBar } from "@/components/console/intents/SentimentBar";
import { type ExamplesLoad, TopicExamples } from "@/components/console/intents/TopicExamples";
import { useOnDemand } from "@/components/console/intents/use-on-demand";
import type { IntentBreakdown } from "@/lib/views/intents/breakdown";
import { intentSentimentRead } from "@/lib/views/intents/topics-explain";
import type { IntentStepsRead } from "@/lib/views/intents/topics-steps-load";
import type { TopicNext, TopicView } from "@/lib/views/intents/topics-view";

/** Reads an intent's panel past what the page holds (`loadIntentDetailAction`): what its asks are for, and its steps. */
export type IntentDetailLoad = (
  topicId: string,
) => Promise<
  | { ok: true; breakdown: IntentBreakdown | null; steps: IntentStepsRead }
  | { ok: false; message: string }
>;

const DETAIL_FAILED = "Couldn't load this intent's detail. Try again in a moment.";

/** "258 asks in 212 conversations", or the asks alone when conversations can't be told apart. */
export function asksInConversations(topic: Pick<TopicView, "turns" | "conversations">): string {
  const asks = `${n(topic.turns)} ${topic.turns === 1 ? "ask" : "asks"}`;
  if (typeof topic.conversations !== "number") return asks;
  return `${asks} in ${n(topic.conversations)} ${topic.conversations === 1 ? "conversation" : "conversations"}`;
}

/**
 * One intent, inspected without leaving the list or the map (DESIGN.md,
 * Overlays: Panel). The open intent lives in the URL (`?peek=`); `j` and `k`
 * step through `order`. Its numbers as marks, what its asks are for and the
 * ways people ask it, example asks and its steps (read on open), the tasks
 * that handle it and the tools they call as pins, what else the same ask
 * wants and what people want next, and the way to its self-corrections,
 * fixes and flows.
 */
export function TopicPanel({
  topics,
  peekId,
  order,
  loadExamples,
  loadDetail,
  onOpen,
  onClose,
}: {
  topics: readonly TopicView[];
  peekId: string | null;
  order: readonly string[];
  loadExamples: ExamplesLoad;
  loadDetail: IntentDetailLoad;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const names = useMemo(() => new Map(topics.map((item) => [item.id, item.name])), [topics]);
  const topic = peekId ? (topics.find((item) => item.id === peekId) ?? null) : null;
  // Keep the last intent while the panel animates out, so it does not blank.
  const [shown, setShown] = useState<TopicView | null>(topic);
  if (topic && shown !== topic) setShown(topic);
  const index = peekId ? order.indexOf(peekId) : -1;
  const step = (direction: 1 | -1) => {
    const next = order[index + direction];
    if (next) onOpen(next);
  };
  return (
    <Panel
      open={topic !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={
        shown ? (
          <span className="flex min-w-0 items-center gap-2">
            <NounIcon noun="intent" className="size-4" />
            <span className="truncate">{shown.name}</span>
          </span>
        ) : (
          ""
        )
      }
      subtitle={shown ? `${asksInConversations(shown)}, last 30 days` : undefined}
      onPrevious={index > 0 ? () => step(-1) : undefined}
      onNext={index >= 0 && index < order.length - 1 ? () => step(1) : undefined}
    >
      {shown ? (
        <TopicBody
          key={shown.id}
          topic={shown}
          names={names}
          loadExamples={loadExamples}
          loadDetail={loadDetail}
          onOpen={onOpen}
        />
      ) : null}
    </Panel>
  );
}

function figures(topic: TopicView): StatProps[] {
  const out: StatProps[] = [
    {
      label: "Asks",
      value: n(topic.turns),
      hint:
        typeof topic.conversations === "number" ? (
          <span className="inline-flex items-center gap-1">
            in
            <NounIcon noun="conversation" className="size-3" />
            {n(topic.conversations)} {topic.conversations === 1 ? "conversation" : "conversations"}
          </span>
        ) : (
          `${pct(topic.share)} of all asks`
        ),
      trend: (
        <DotSpark values={topic.trend} rows={4} label="Asks every two days over the last 30 days" />
      ),
    },
    {
      label: "Answered",
      value: pct(topic.answeredShare),
      hint: `${n(topic.answered)} of ${n(topic.turns)}`,
      trend: (
        <DotMeter
          value={topic.answeredShare}
          cells={10}
          tone={topic.mostlyUnanswered ? "warning" : "neutral"}
          label={`Answered ${pct(topic.answeredShare)}`}
        />
      ),
    },
  ];
  if (topic.sentiment && topic.sentiment.measured > 0) {
    out.push({
      label: "Negative",
      value: pct(topic.sentiment.negativeShare),
      hint: intentSentimentRead(topic.sentiment.measured, topic.turns),
      trend: <SentimentBar sentiment={topic.sentiment} bare />,
    });
  }
  out.push({ label: "Asked again", value: n(topic.askedAgain), hint: "right after" });
  return out;
}

/** What came next, by its mark: an intent opens its own panel; a task or a tool is its pin. */
function NextMark({ next, onOpen }: { next: TopicNext; onOpen: (id: string) => void }) {
  if (next.kind === "topic")
    return <IntentButton name={next.label} onOpen={() => onOpen(next.key)} />;
  if (next.kind === "task" && next.href)
    return (
      <TaskPin
        name={next.label}
        slot={next.slot ?? null}
        href={next.href}
        className="justify-self-start"
      />
    );
  if (next.kind === "tool" && next.href)
    return <StoredToolPin id={next.label} href={next.href} className="justify-self-start" />;
  const Icon = next.kind === "retry" ? RotateCcw : next.kind === "ended" ? Flag : MoreHorizontal;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-ui text-fg-muted">
      <Icon aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0 text-fg-subtle" />
      <span className="truncate">{next.label}</span>
    </span>
  );
}

export function TopicBody({
  topic,
  names = new Map(),
  loadExamples,
  loadDetail,
  onOpen,
}: {
  topic: TopicView;
  /** Every intent's name by id, for the other intents its asks lead to. */
  names?: ReadonlyMap<string, string>;
  loadExamples: ExamplesLoad;
  /** Without it the panel shows what the page holds. */
  loadDetail?: IntentDetailLoad;
  onOpen: (id: string) => void;
}) {
  const unanswered = topic.turns - topic.answered;
  const corrections = topic.selfCorrections;
  const stats = figures(topic);
  const detail = useOnDemand(
    loadDetail ? () => loadDetail(topic.id) : undefined,
    topic.id,
    DETAIL_FAILED,
  );
  const ready = detail.status === "ready" ? detail.result : null;
  return (
    <div className="flex flex-col gap-6" data-panel-kind="intent">
      {topic.description ? <p className="text-sm text-fg-muted">{topic.description}</p> : null}

      {/* Two by two: a panel is too narrow for four numbers and their lines side by side. */}
      <StatRow stats={stats} className={stats.length === 4 ? "lg:grid-cols-2" : undefined} />

      {topic.mostlyUnanswered ? (
        <p className="flex items-center gap-2 rounded-md bg-warning-subtle px-3 py-2 text-ui text-fg">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-warning" />
          <span>
            <span className="font-medium">Mostly unanswered:</span> {n(unanswered)} of{" "}
            {n(topic.turns)} asks got no working answer.
          </span>
        </p>
      ) : null}

      {detail.status === "loading" ? (
        <AskForLoading />
      ) : detail.status === "error" ? (
        <Block noun="intent" title="What they ask for">
          <p className="text-ui text-fg-muted">{detail.message}</p>
        </Block>
      ) : ready?.breakdown ? (
        <AskFor breakdown={ready.breakdown} names={names} onOpen={onOpen} />
      ) : null}

      <TopicExamples target={{ kind: "topic", topicId: topic.id }} load={loadExamples} />

      {detail.status === "loading" ? (
        <IntentStepsLoading />
      ) : ready ? (
        <IntentSteps read={ready.steps} topic={topic} />
      ) : null}

      <Block noun="task" title="Tasks that handle it">
        {topic.tasks.length === 0 ? (
          <p className="text-ui text-fg-muted">No task handles these asks yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {topic.tasks.map((task) => (
              <li
                key={task.id}
                className="grid grid-cols-[minmax(0,1fr)_auto_2.5rem] items-center gap-3"
              >
                <TaskPin
                  name={task.name}
                  slot={task.slot}
                  href={task.href}
                  className="justify-self-start"
                />
                <Share share={task.share} label="of its asks" />
              </li>
            ))}
            {topic.untasked > 0 ? (
              <li className="grid grid-cols-[minmax(0,1fr)_auto_2.5rem] items-center gap-3">
                <span className="text-xs text-fg-subtle">No task</span>
                <Share share={topic.untasked / Math.max(1, topic.turns)} label="of its asks" />
              </li>
            ) : null}
          </ul>
        )}
      </Block>

      <Block noun="tool" title="Tools its asks call">
        {topic.tools.length === 0 ? (
          <p className="text-ui text-fg-muted">No tool ran for these asks.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {topic.tools.map((tool) => (
              <li
                key={tool.id}
                className="grid grid-cols-[minmax(0,1fr)_auto_6rem] items-center gap-3"
              >
                <StoredToolPin id={tool.id} href={tool.href} className="justify-self-start" />
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
                      {n(tool.failures)} failed
                    </>
                  ) : (
                    "No failures"
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      {ready?.breakdown ? (
        <AlsoWants breakdown={ready.breakdown} names={names} onOpen={onOpen} />
      ) : null}

      <Block noun="flow" title="What people want next">
        {topic.next.length === 0 ? (
          <p className="text-ui text-fg-muted">No conversation went on from this intent.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {topic.next.map((next) => (
              <li
                key={next.key}
                className="grid grid-cols-[minmax(0,1fr)_auto_2.5rem] items-center gap-3"
              >
                <NextMark next={next} onOpen={onOpen} />
                <Share share={next.share} label="of what came next" />
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block
        noun="selfCorrection"
        title="Self-corrections"
        action={
          <Link
            href={topic.links.selfCorrections}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            See all
            <ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
        }
      >
        {corrections && corrections.events > 0 ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-ui">
            <span className="text-fg-muted tabular-nums">
              <span className="text-fg">{n(corrections.events)}</span> in {n(corrections.turns)}{" "}
              {corrections.turns === 1 ? "ask" : "asks"}
            </span>
            <span className="flex flex-wrap gap-1.5">
              {corrections.kinds.map((kind) => (
                <Badge key={kind.kind}>
                  {kind.label} <span className="tabular-nums">{n(kind.events)}</span>
                </Badge>
              ))}
            </span>
          </div>
        ) : (
          <p className="text-ui text-fg-muted">None in these asks.</p>
        )}
      </Block>

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={topic.links.fixes}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <NounIcon noun="fix" className="text-current" />
          See fixes
        </Link>
        <Link href={topic.links.flows} className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <NounIcon noun="flow" className="text-current" />
          Open in Flows
        </Link>
      </div>
    </div>
  );
}
