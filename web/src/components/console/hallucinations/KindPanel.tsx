"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { GROUP_COLOR } from "@/components/console/hallucinations/copy";
import { percent, plural } from "@/components/console/sentiment/copy";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import { formatRelativeTime, formatTimestamp } from "@/lib/synthesis/traces/v2/format";
import type { GroupView, KindView } from "@/lib/views/health/hallucinations/page-links";
import { KIND_PEEK } from "@/lib/views/health/hallucinations/paths";

/**
 * One kind of hallucination, opened from its row: what it is, how often it
 * happened, the tools it happened on (for a reroute, the name the agent
 * asked for and the tool that ran, with how many still worked), and where it
 * happened: its newest occurrences, each a date and the call in Traces.
 * `j` and `k` step through the kinds listed.
 */
export function KindPanel({ groups, now }: { groups: readonly GroupView[]; now: string }) {
  const peek = usePeek(KIND_PEEK);
  const kinds = groups.flatMap((group) => group.kinds);
  const index = kinds.findIndex((kind) => kind.kind === peek.id);
  const kind = index >= 0 ? kinds[index] : undefined;
  const step = (by: 1 | -1) => {
    const next = kinds[index + by];
    if (next) peek.open(next.kind);
  };
  return (
    <Panel
      open={kind !== undefined}
      onOpenChange={(next) => {
        if (!next) peek.close();
      }}
      title={kind?.label ?? "Hallucination"}
      subtitle={kind?.groupLabel}
      onPrevious={index > 0 ? () => step(-1) : undefined}
      onNext={index >= 0 && index < kinds.length - 1 ? () => step(1) : undefined}
    >
      {kind ? <Body kind={kind} now={now} /> : null}
    </Panel>
  );
}

function Body({ kind, now }: { kind: KindView; now: string }) {
  const reroute = kind.tools.some((tool) => tool.requestedName !== null);
  return (
    <div className="flex flex-col gap-6" data-hallucination-kind={kind.kind}>
      <section className="flex flex-col gap-3" aria-label="What it is">
        <p className="text-sm text-fg">{kind.meaning}</p>
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-ui">
          <dt className="text-fg-subtle">Group</dt>
          <dd className="flex items-center gap-2 text-fg">
            <span aria-hidden className={cn("size-2 rounded-[2px]", GROUP_COLOR[kind.group])} />
            {kind.groupLabel}
          </dd>
          <dt className="text-fg-subtle">How often</dt>
          <dd className="flex flex-wrap items-baseline gap-x-2 text-fg">
            <span className="tabular-nums">{plural(kind.occurrences, "time")}</span>
            <span className="text-fg-subtle tabular-nums">{`${percent(kind.share)} of all hallucinations · ${plural(kind.turns, "turn")}`}</span>
          </dd>
        </dl>
      </section>

      <section className="flex flex-col gap-3" aria-label={reroute ? "Asked for and ran" : "Tools"}>
        <h3 className="text-sm font-semibold text-fg">
          {reroute ? "Asked for and ran" : "Tools it happened on"}
        </h3>
        <ul className="flex flex-col border-t border-line" data-hallucination-tools="">
          {kind.tools.map((tool) => (
            <li
              key={`${tool.requestedName ?? ""}>${tool.toolId}`}
              className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line py-1 text-ui"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-xs text-fg">
                {tool.requestedName ? (
                  <>
                    <span className="text-fg-muted">{tool.requestedName}</span>
                    <ArrowRight aria-label="ran as" className="size-3 shrink-0 text-fg-subtle" />
                  </>
                ) : null}
                <span>{tool.toolName}</span>
              </span>
              <span className="flex items-baseline gap-2 text-xs text-fg-subtle tabular-nums">
                {tool.requestedName ? (
                  <span>
                    {tool.worked === tool.occurrences
                      ? "all worked anyway"
                      : tool.worked === 0
                        ? "none worked"
                        : `${formatCount(tool.worked)} worked anyway`}
                  </span>
                ) : null}
                <span className="text-ui text-fg">{formatCount(tool.occurrences)}</span>
              </span>
            </li>
          ))}
        </ul>
        {kind.moreTools > 0 ? (
          <p className="text-xs text-fg-subtle">{`And ${plural(kind.moreTools, "more tool")}.`}</p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3" aria-label="Where it happened">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-fg">Where it happened</h3>
          <span className="text-xs text-fg-subtle">
            {kind.occurrences > kind.examples.length
              ? `The newest ${formatCount(kind.examples.length)} of ${formatCount(kind.occurrences)}`
              : plural(kind.examples.length, "time")}
          </span>
        </div>
        <ul className="flex flex-col border-t border-line" data-hallucination-where="">
          {kind.examples.map((example, at) => (
            <li
              key={`${example.turnId}:${at}`}
              className="flex min-h-10 items-center justify-between gap-3 border-b border-line"
            >
              <time
                dateTime={example.occurredAt}
                title={formatRelativeTime(example.occurredAt, now)}
                className="text-ui text-fg tabular-nums"
              >
                {formatTimestamp(example.occurredAt)}
              </time>
              <Link
                href={example.traceHref}
                className={buttonVariants({ variant: "secondary", size: "sm" })}
                data-hallucination-open-trace=""
              >
                Open in Traces
                <ArrowUpRight aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
