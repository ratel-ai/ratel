"use client";

import { Button } from "@ratel/design-system/button";
import { PeekLink } from "@ratel/design-system/panel";
import { Popover, PopoverContent, PopoverTrigger } from "@ratel/design-system/popover";
import { Section } from "@ratel/design-system/section";
import { EmptyState } from "@ratel/design-system/states";
import {
  ChevronRight,
  CircleX,
  type LucideIcon,
  MessageSquareX,
  SquareArrowOutUpRight,
  WrenchOff,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { SEARCH_ASKS_TEXT } from "@/components/console/health/section-preview-model";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import { setupPeek } from "@/components/console/health/v2/setup-peek";
import type { SetupKey } from "@/lib/readings/trace-signals/setup-facts";
import { turnTracesHref, type UnservedAskView } from "@/lib/readings/trace-signals/view";

/**
 * Requests no task or tool handles: each may need a new tool. One compact
 * row each: an icon for why (no tool does it, or its runs failed), the
 * request on one line, and how many runs asked it. A click shows one
 * example, the request whole with another way it was asked, and a run to
 * open in Traces. The words are the users' own, so they appear only as
 * text, never in an attribute. When no request text arrives at all, how to
 * send it.
 */

/** The same words as the Tasks page's row (`components/tasks/TasksTable.tsx`). */
export const UNSERVED_TITLE = "Asks no task handles";
const SHOWN = 6;

type Reason = NonNullable<UnservedAskView["reason"]> | "unknown";

const REASON: Readonly<Record<Reason, { Icon: LucideIcon; text: string }>> = {
  no_tool: { Icon: WrenchOff, text: "No tool does this." },
  unresolved: { Icon: CircleX, text: "The runs failed or called no tool." },
  unknown: { Icon: MessageSquareX, text: "No task handles this." },
};

const runsText = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "run" : "runs"}`;

export function UnservedSection({
  projectId,
  asks,
  asksFrom,
  asksSetupKey,
}: {
  projectId: string;
  asks: readonly UnservedAskView[];
  /** Read from the agent's searches rather than what users wrote. */
  asksFrom: "user" | "search" | "mixed" | null;
  /** Set when no request text arrives at all: the guide that sends it. */
  asksSetupKey: SetupKey | null;
}) {
  const [all, setAll] = useState(false);
  if (asks.length === 0 && !asksSetupKey) return null;
  const runs = asks.reduce((sum, ask) => sum + ask.runs, 0);
  return (
    <Section
      title={<NounTitle icon={MessageSquareX}>{UNSERVED_TITLE}</NounTitle>}
      description={
        asks.length > 0
          ? `${asks.length.toLocaleString("en-US")} ${asks.length === 1 ? "ask" : "asks"} · ${runsText(runs)}`
          : undefined
      }
    >
      {asks.length === 0 && asksSetupKey ? (
        <div className="rounded-lg border border-line" data-unserved="no_asks">
          <EmptyState
            title="No asks captured"
            description="Send what people ask to see the asks no task or tool handles."
            action={
              <PeekLink
                peek={setupPeek(asksSetupKey)}
                className="text-ui text-fg underline underline-offset-2 hover:decoration-fg-muted"
              >
                How to send them
              </PeekLink>
            }
          />
        </div>
      ) : (
        <div className="flex flex-col" data-unserved={asks.length}>
          <ul className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
            {(all ? asks : asks.slice(0, SHOWN)).map((ask, index) => (
              <AskRow key={index} index={index} projectId={projectId} ask={ask} />
            ))}
          </ul>
          {asks.length > SHOWN ? (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 self-start"
              aria-expanded={all}
              onClick={() => setAll(!all)}
            >
              {all ? `Show only the first ${SHOWN}` : `Show all ${asks.length} asks`}
            </Button>
          ) : null}
          {asksFrom === "search" ? (
            <p className="mt-3 text-xs text-fg-subtle">{SEARCH_ASKS_TEXT}</p>
          ) : null}
        </div>
      )}
    </Section>
  );
}

/** One request: why, what (one line), how often; one example on a click. */
function AskRow({
  index,
  projectId,
  ask,
}: {
  index: number;
  projectId: string;
  ask: UnservedAskView;
}) {
  const { Icon } = REASON[ask.reason ?? "unknown"];
  return (
    <li className="border-b border-line" data-unserved-ask={index}>
      <Popover>
        <PopoverTrigger className="group flex min-h-10 w-full items-center gap-3 rounded-md px-1 py-2 text-left outline-none transition-colors duration-120 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus data-popup-open:bg-selected">
          <Icon aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1 truncate text-ui text-fg">{ask.title}</span>
          <span className="shrink-0 text-xs text-fg-subtle tabular-nums">{runsText(ask.runs)}</span>
          <ChevronRight
            aria-hidden
            className="size-3.5 shrink-0 text-fg-faint transition-transform duration-120 group-data-popup-open:rotate-90"
          />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(28rem,calc(100vw-2rem))]">
          <AskExample projectId={projectId} ask={ask} />
        </PopoverContent>
      </Popover>
    </li>
  );
}

/** The example a click shows: the request whole, another way it was asked, why it counts, and a run to open. */
export function AskExample({ projectId, ask }: { projectId: string; ask: UnservedAskView }) {
  const reason = REASON[ask.reason ?? "unknown"];
  const { Icon } = reason;
  const turnId = ask.turnIds[0];
  return (
    <div className="flex flex-col gap-3" data-unserved-example="">
      <p className="text-sm text-fg">“{ask.title}”</p>
      {ask.others[0] ? (
        <p className="text-ui text-fg-muted">
          <span className="text-fg-subtle">Also asked: </span>“{ask.others[0]}”
        </p>
      ) : null}
      <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
        <Icon aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0" />
        {reason.text} {runsText(ask.runs)}.
      </p>
      {turnId ? (
        <Link
          href={turnTracesHref(projectId, turnId)}
          className="inline-flex items-center gap-1 self-start rounded-sm text-ui text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
        >
          <SquareArrowOutUpRight aria-hidden className="size-3.5" />
          Open a run in Traces
        </Link>
      ) : null}
    </div>
  );
}
