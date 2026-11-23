"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { ToolPin } from "@ratel/design-system/entity";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { NO_CAUSE_LABEL, percent, plural, STATUS_COLOR } from "@/components/console/sentiment/copy";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import { formatRelativeTime, formatTimestamp } from "@/lib/synthesis/traces/v2/format";
import { CAUSE_LABEL, CAUSE_MEANING } from "@/lib/views/traces/sentiment/page-kinds";
import type { ReasonGroupView, ReasonRowView } from "@/lib/views/traces/sentiment/page-links";

/** The URL parameter that holds the open root cause: its reason's key and its own, `<reason>:<cause>|<tool>`. */
export const ROOT_CAUSE_PEEK = "open";

const LINK =
  "rounded-sm text-ui font-medium text-fg-muted outline-none hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-focus";

export const rootCauseKey = (group: ReasonGroupView, row: ReasonRowView) =>
  `${group.key}:${row.key}`;

/**
 * One root cause, opened from its row in Root causes by reason: what it is
 * (the cause, its meaning, the reason, how often it happened and the tool),
 * and where it happened (its newest tasks, each a date and the turn in
 * Traces). `j` and `k` step through the rows listed.
 */
export function RootCausePanel({
  groups,
  now,
}: {
  groups: readonly ReasonGroupView[];
  now: string;
}) {
  const peek = usePeek(ROOT_CAUSE_PEEK);
  const entries = groups.flatMap((group) =>
    group.rows.map((row) => ({ group, row, key: rootCauseKey(group, row) })),
  );
  const index = entries.findIndex((entry) => entry.key === peek.id);
  const entry = index >= 0 ? entries[index] : undefined;
  const step = (by: 1 | -1) => {
    const next = entries[index + by];
    if (next) peek.open(next.key);
  };
  return (
    <Panel
      open={entry !== undefined}
      onOpenChange={(next) => {
        if (!next) peek.close();
      }}
      title={
        entry ? (entry.row.cause ? CAUSE_LABEL[entry.row.cause] : NO_CAUSE_LABEL) : "Root cause"
      }
      subtitle={
        entry
          ? `${entry.group.label} · ${entry.group.result === "not_completed" ? "Not completed" : "Completed after friction"}`
          : undefined
      }
      onPrevious={index > 0 ? () => step(-1) : undefined}
      onNext={index >= 0 && index < entries.length - 1 ? () => step(1) : undefined}
    >
      {entry ? <Body group={entry.group} row={entry.row} now={now} /> : null}
    </Panel>
  );
}

function Body({ group, row, now }: { group: ReasonGroupView; row: ReasonRowView; now: string }) {
  const share = group.tasks === 0 ? 0 : row.tasks / group.tasks;
  return (
    <div className="flex flex-col gap-6" data-root-cause-panel={row.key}>
      {/* What it is. */}
      <section className="flex flex-col gap-3" aria-label="What it is">
        <p className="text-sm text-fg">
          {row.cause
            ? CAUSE_MEANING[row.cause]
            : "No call failed and no model named what went wrong in these tasks: the reason is all there is."}
        </p>
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-ui">
          <dt className="text-fg-subtle">Reason</dt>
          <dd className="flex items-center gap-2 text-fg">
            <span
              aria-hidden
              className={cn("size-2 rounded-[2px]", STATUS_COLOR[group.result].bg)}
            />
            {group.label}
          </dd>
          <dt className="text-fg-subtle">How often</dt>
          <dd
            className="flex flex-wrap items-baseline gap-x-2 text-fg"
            data-root-cause-frequency=""
          >
            <span className="tabular-nums">{plural(row.tasks, "time")}</span>
            <span className="text-fg-subtle tabular-nums">{`${percent(share)} of the tasks with this reason`}</span>
          </dd>
          <dt className="text-fg-subtle">Tool</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-3">
            {row.toolName && row.toolHref ? (
              <>
                <span className="flex max-w-[14rem] min-w-0">
                  <ToolPin name={row.toolName} kind={row.toolKind} href={row.toolHref} />
                </span>
                {row.catalogHref ? (
                  <Link href={row.catalogHref} className={LINK}>
                    Open in Catalog
                  </Link>
                ) : null}
              </>
            ) : (
              <span className="text-fg-subtle">None</span>
            )}
          </dd>
        </dl>
      </section>

      {/* Where it happened: one row per task, its date and the way to the turn in Traces. */}
      <section className="flex flex-col gap-3" aria-label="Where it happened">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-fg">Where it happened</h3>
          <span className="text-xs text-fg-subtle">
            {row.tasks > row.examples.length
              ? `The newest ${formatCount(row.examples.length)} of ${plural(row.tasks, "task")}`
              : plural(row.examples.length, "task")}
          </span>
        </div>
        <ul className="flex flex-col border-t border-line" data-root-cause-where="">
          {row.examples.map((example) => (
            <li
              key={example.taskId}
              className="flex min-h-10 items-center justify-between gap-3 border-b border-line"
            >
              <time
                dateTime={example.endedAt}
                title={formatRelativeTime(example.endedAt, now)}
                className="text-ui text-fg tabular-nums"
              >
                {formatTimestamp(example.endedAt)}
              </time>
              <Link
                href={example.traceHref}
                className={buttonVariants({ variant: "secondary", size: "sm" })}
                data-root-cause-open-trace=""
              >
                Open in Traces
                <ArrowUpRight aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
        {row.causeHref ? (
          <Link href={row.causeHref} scroll={false} className={cn(LINK, "self-start")}>
            Show only this cause on the page
          </Link>
        ) : null}
      </section>
    </div>
  );
}
