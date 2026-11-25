import type { ReactNode } from "react";
import { formatTimestamp } from "@/lib/synthesis/traces/format";
import { relativeTimeLabel } from "@/lib/views/intents/adaptive-view";
import type { LayoutHistoryEntry } from "@/lib/views/overview-layout/actions";
import type { ChangeSource } from "@/lib/views/overview-layout/domain/history";

/** An entry as it is drawn, in the console and in a chat. */
export type DrawnEntry = Pick<LayoutHistoryEntry, "id" | "source" | "summary" | "current"> & {
  at: Date | string;
  /** False for a layout that this build cannot read. */
  readable?: boolean;
};

/** The changes of a person's layout, newest first. */
export function LayoutHistoryList<E extends DrawnEntry>({
  entries,
  now,
  action,
}: {
  entries: readonly E[];
  now: Date;
  /** What a person can do with an entry; null where there is nothing. */
  action?: (entry: E) => ReactNode;
}) {
  return (
    <ol className="divide-y divide-line" data-layout-history="">
      {entries.map((entry) => {
        const at = new Date(entry.at);
        return (
          <li
            key={entry.id}
            data-layout-entry={entry.id}
            className="flex min-h-11 items-center gap-3 py-2.5 first:pt-0 last:pb-0"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-ui font-medium wrap-break-word text-fg">
                {entry.summary}
              </span>
              <span className="block text-xs wrap-break-word text-fg-subtle">
                {madeBy(entry.source)},{" "}
                <time dateTime={at.toISOString()} title={formatTimestamp(at)}>
                  {relativeTimeLabel(at, now)}
                </time>
              </span>
            </span>
            {entry.current ? (
              <span className="shrink-0 text-xs text-fg-subtle">Current layout</span>
            ) : entry.readable === false ? (
              <span className="shrink-0 text-xs text-fg-subtle">Made by a newer version</span>
            ) : (
              action?.(entry)
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** A layout is personal, so its author is the person who reads the history. */
export function madeBy(source: ChangeSource): string {
  if (source.kind === "web") return "You on the web";
  return `You through ${source.client ?? "an MCP client"}`;
}
