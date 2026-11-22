"use client";

import { cn } from "@ratel/design-system/cn";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { storyDay } from "@/components/console/health/TurnStory";
import { peekedReading, type ReadingView } from "@/components/console/health/v2/reading-views";

/**
 * One reading in a Panel: its value and change, what it means, the range it
 * likely sits in, who decided it, and the last seven days as numbers (the
 * table beside the pixels, DESIGN.md Data visualization).
 */
export function ReadingsPanel({ readings }: { readings: readonly ReadingView[] }) {
  const peek = usePeek();
  const key = peekedReading(peek.id);
  const reading = readings.find((each) => each.key === key) ?? null;
  const [shown, setShown] = useState<ReadingView | null>(reading);
  if (reading && reading !== shown) setShown(reading);
  const index = reading ? readings.indexOf(reading) : -1;
  return (
    <Panel
      open={reading !== null}
      onOpenChange={(next) => {
        if (!next) peek.close();
      }}
      title={shown?.label ?? "Reading"}
      subtitle="This window, against the one before"
      onPrevious={index > 0 ? () => peek.open(readings[index - 1]!.peek) : undefined}
      onNext={
        index >= 0 && index < readings.length - 1
          ? () => peek.open(readings[index + 1]!.peek)
          : undefined
      }
    >
      {shown ? <ReadingBody reading={shown} /> : null}
    </Panel>
  );
}

function ReadingBody({ reading }: { reading: ReadingView }) {
  const Icon =
    reading.delta?.direction === "up"
      ? ArrowUpRight
      : reading.delta?.direction === "down"
        ? ArrowDownRight
        : ArrowRight;
  const tone =
    !reading.delta || reading.delta.good === null || reading.delta.direction === "flat"
      ? "text-fg-subtle"
      : reading.delta.good
        ? "text-success"
        : "text-danger";
  return (
    <div className="flex flex-col gap-6" data-reading={reading.key}>
      <div className="flex flex-col gap-1">
        <p className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tracking-tight text-fg tabular-nums">
            {reading.value}
          </span>
          {reading.delta ? (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 text-xs font-medium tabular-nums",
                tone,
              )}
            >
              <Icon aria-hidden className="size-3" />
              {reading.delta.value}
              <span className="text-fg-subtle"> {reading.delta.label}</span>
            </span>
          ) : null}
        </p>
        <p className="text-ui text-fg-muted">{reading.meaning}</p>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-ui">
        {reading.hint ? (
          <>
            <dt className="text-fg-subtle">Counted from</dt>
            <dd className="text-fg">{reading.hint}</dd>
          </>
        ) : null}
        {reading.range ? (
          <>
            <dt className="text-fg-subtle">Likely between</dt>
            <dd className="text-fg tabular-nums">{reading.range}</dd>
          </>
        ) : null}
        <dt className="text-fg-subtle">How we know</dt>
        <dd className="text-fg">{reading.decidedBy}</dd>
      </dl>
      {reading.days.length > 0 ? (
        <table className="w-full border-separate border-spacing-0 text-ui">
          <caption className="pb-2 text-left text-sm font-semibold text-fg">
            The last 7 days
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="h-8 border-b border-line text-left text-xs font-medium text-fg-subtle"
              >
                Day
              </th>
              <th
                scope="col"
                className="h-8 border-b border-line text-right text-xs font-medium text-fg-subtle"
              >
                {reading.label}
              </th>
            </tr>
          </thead>
          <tbody>
            {reading.days.map((day) => (
              <tr key={day.day}>
                <td className="h-8 border-b border-line text-fg-muted">
                  {storyDay(`${day.day}T00:00:00.000Z`)}
                </td>
                <td className="h-8 border-b border-line text-right text-fg tabular-nums">
                  {day.value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
