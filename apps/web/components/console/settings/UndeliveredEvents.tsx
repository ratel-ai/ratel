"use client";

import { type Column, DataTable } from "@ratel/design-system/data-table";
import { EmptyState } from "@ratel/design-system/states";
import { CircleCheck } from "lucide-react";
import { useMemo } from "react";
import { formatBytes, formatStamp, relativeTime } from "@/lib/console/settings/format";
import {
  type DropView,
  humanizeEventType,
  type RejectView,
  SDK_EVENT_LIST_LIMIT,
} from "@/lib/console/settings/sdk-events";

/**
 * What did not make it in this window: events Ratel Cloud refused (with the
 * reason, so the producer can fix it) and events the SDK shed before sending
 * (from its own drop reports). Cloud keeps only the metadata of a refused
 * event, never its payload.
 */
export function UndeliveredEvents({
  rejects,
  drops,
  now,
}: {
  rejects: readonly RejectView[];
  drops: readonly DropView[];
  now: string;
}) {
  const at = useMemo(() => new Date(now), [now]);

  if (rejects.length === 0 && drops.length === 0) {
    return (
      <EmptyState
        icon={CircleCheck}
        title="Nothing dropped or rejected"
        description="Every event the SDK sent in this window arrived."
        className="border-t border-line"
      />
    );
  }

  const rejectColumns: readonly Column<RejectView>[] = [
    {
      id: "reason",
      header: "Reason",
      cell: (reject) => (
        <span
          title={reject.eventId ?? undefined}
          className="block max-w-[32rem] min-w-40 truncate text-fg"
        >
          {reject.reason}
        </span>
      ),
    },
    {
      id: "event",
      header: "Event",
      width: "12rem",
      cell: (reject) => (
        <span className="whitespace-nowrap text-fg-muted">{reject.label ?? "Unknown"}</span>
      ),
    },
    {
      id: "source",
      header: "Source",
      width: "11rem",
      cell: (reject) => (
        <code translate="no" className="block max-w-40 truncate font-mono text-xs text-fg-muted">
          {reject.source ?? "Unknown"}
        </code>
      ),
    },
    {
      id: "size",
      header: "Size",
      align: "right",
      width: "6rem",
      cell: (reject) => formatBytes(reject.sizeBytes),
    },
    {
      id: "time",
      header: "Time",
      align: "right",
      width: "6.5rem",
      cell: (reject) => (
        <time
          dateTime={reject.at}
          title={formatStamp(reject.at)}
          className="whitespace-nowrap text-fg-muted"
        >
          {relativeTime(reject.at, at)}
        </time>
      ),
    },
  ];

  const dropColumns: readonly Column<DropView>[] = [
    {
      id: "source",
      header: "Source",
      cell: (drop) => (
        <code translate="no" className="font-mono text-xs text-fg">
          {drop.source ?? "Unknown"}
        </code>
      ),
    },
    {
      id: "reason",
      header: "Reason",
      width: "14rem",
      cell: (drop) => (
        <span className="text-fg-muted">
          {drop.reason ? humanizeEventType(drop.reason) : "Not reported"}
        </span>
      ),
    },
    {
      id: "dropped",
      header: "Events",
      align: "right",
      width: "6rem",
      cell: (drop) => drop.dropped.toLocaleString("en-US"),
    },
    {
      id: "reports",
      header: "Reports",
      align: "right",
      width: "6rem",
      cell: (drop) => drop.reports.toLocaleString("en-US"),
    },
    {
      id: "time",
      header: "Last",
      align: "right",
      width: "6.5rem",
      cell: (drop) => (
        <time
          dateTime={drop.lastAt}
          title={formatStamp(drop.lastAt)}
          className="whitespace-nowrap text-fg-muted"
        >
          {relativeTime(drop.lastAt, at)}
        </time>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <ListHeading
          title="Rejected by Ratel Cloud"
          note={
            rejects.length >= SDK_EVENT_LIST_LIMIT ? `The newest ${SDK_EVENT_LIST_LIMIT}` : null
          }
        />
        <DataTable
          caption="Events Ratel Cloud rejected"
          columns={rejectColumns}
          rows={rejects}
          rowKey={(reject) => reject.key}
          density="compact"
          empty={<p className="px-3 py-4 text-ui text-fg-muted">None in this window.</p>}
        />
      </div>
      <div className="flex flex-col gap-2">
        <ListHeading
          title="Dropped by the SDK"
          note={
            drops.length >= SDK_EVENT_LIST_LIMIT
              ? `The ${SDK_EVENT_LIST_LIMIT} largest groups`
              : null
          }
        />
        <DataTable
          caption="Events the SDK dropped before sending"
          columns={dropColumns}
          rows={drops}
          rowKey={(drop) => drop.key}
          density="compact"
          empty={<p className="px-3 py-4 text-ui text-fg-muted">None in this window.</p>}
        />
      </div>
    </div>
  );
}

/** A list's heading, with a note when the list is a full page rather than everything. */
function ListHeading({ title, note }: { title: string; note: string | null }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <h3 className="text-ui font-medium text-fg">{title}</h3>
      {note ? <span className="text-xs text-fg-subtle tabular-nums">{note}</span> : null}
    </div>
  );
}
