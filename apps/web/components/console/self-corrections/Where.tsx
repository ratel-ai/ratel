import { cn } from "@ratel/design-system/cn";
import { DotMeter } from "@ratel/design-system/dot-matrix";
import { IntentPin, type Noun, NounIcon, TaskPin, ToolPin } from "@ratel/design-system/entity";
import { Section } from "@ratel/design-system/section";
import { MapPin } from "lucide-react";
import type { ReactNode } from "react";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import type { SelfCorrectionsPageModel } from "@/lib/views/health/self-corrections/page-model";

/**
 * Where self-corrections happen, three short lists side by side: after which
 * tool, in which task, for which intent. Each row is the thing's pin, a bar
 * against its list's largest and the count; a pin narrows the whole page to
 * it (`?tool=`, `?task=`, `?topic=`), where its own page is one link away.
 * The bar is drawn against the largest row so a list scans at a glance; its
 * accessible name says the row's real share.
 */

const SHOWN = 6;

interface Row {
  key: string;
  pin: ReactNode;
  events: number;
  share: number;
  muted?: boolean;
}

export function Where({ model }: { model: SelfCorrectionsPageModel }) {
  const tools: Row[] = [
    ...model.byTool.slice(0, SHOWN).map((row) => ({
      key: row.node,
      pin: <ToolPin name={row.name} kind={row.entryKind} href={row.filterHref} />,
      events: row.events,
      share: row.share,
    })),
    ...(model.withoutTool > 0
      ? [
          {
            key: "none",
            pin: <Quiet>Before any tool call</Quiet>,
            events: model.withoutTool,
            share: model.withoutTool / Math.max(1, model.events),
            muted: true,
          },
        ]
      : []),
  ];
  const tasks: Row[] = [
    ...model.byTask.slice(0, SHOWN).map((row) => ({
      key: row.id,
      pin: <TaskPin name={row.name} slot={row.color} href={row.filterHref} />,
      events: row.events,
      share: row.share,
    })),
    ...(model.unplaced.events > 0
      ? [
          {
            key: "none",
            pin: <Quiet>In no task</Quiet>,
            events: model.unplaced.events,
            share: model.unplaced.events / Math.max(1, model.events),
            muted: true,
          },
        ]
      : []),
  ];
  const intents: Row[] | null = model.byTopic
    ? model.byTopic.slice(0, SHOWN).map((row) => ({
        key: row.id,
        pin: <IntentPin name={row.name} href={row.filterHref} />,
        events: row.events,
        share: row.share,
      }))
    : null;
  return (
    <Section title={<NounTitle icon={MapPin}>Where it happens</NounTitle>}>
      <div className="grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-3" data-corrections-where="">
        <Column
          noun="tool"
          title="After a tool"
          rows={tools}
          empty="No self-correction came after a tool call."
        />
        <Column noun="task" title="In a task" rows={tasks} empty="No task had a self-correction." />
        <Column
          noun="intent"
          title="For an intent"
          rows={intents ?? []}
          empty={
            intents === null
              ? "Intents show once people's asks are grouped."
              : "No intent had a self-correction."
          }
        />
      </div>
    </Section>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <span className="truncate text-ui text-fg-subtle">{children}</span>;
}

function Column({
  noun,
  title,
  rows,
  empty,
}: {
  noun: Noun;
  title: string;
  rows: readonly Row[];
  empty: string;
}) {
  const most = Math.max(0, ...rows.map((row) => row.events));
  return (
    <div className="flex min-w-0 flex-col gap-2" data-where={noun}>
      <h3 className="flex items-center gap-2 text-ui font-medium text-fg-muted">
        <NounIcon noun={noun} />
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="py-1 text-ui text-fg-subtle">{empty}</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li key={row.key} className="flex min-h-9 items-center gap-3 border-b border-line py-1">
              <span className="flex min-w-0 flex-1">{row.pin}</span>
              <DotMeter
                value={most > 0 ? row.events / most : 0}
                cells={10}
                tone="neutral"
                label={`${Math.round(row.share * 100)}% of self-corrections`}
                className="shrink-0 max-sm:hidden"
              />
              <span
                className={cn(
                  "w-10 shrink-0 text-right text-ui tabular-nums",
                  row.muted ? "text-fg-subtle" : "text-fg",
                )}
              >
                {formatCount(row.events)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
