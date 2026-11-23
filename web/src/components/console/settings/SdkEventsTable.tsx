"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { usePeek } from "@ratel/design-system/panel";
import { stepIndex } from "@ratel/design-system/peek";
import { EmptyState } from "@ratel/design-system/states";
import { Radio } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { SdkEventPanel } from "@/components/console/settings/SdkEventPanel";
import { useSdkEventPayload } from "@/components/console/settings/use-sdk-event-payload";
import { formatDuration, formatStamp, relativeTime } from "@/lib/console/settings/format";
import {
  SDK_EVENT_PARAM,
  type SdkEventPayload,
  type SdkEventView,
} from "@/lib/console/settings/sdk-events";

/**
 * The raw SDK events, newest first. A row opens its Panel (`?event=<id>`, the
 * parameter the v1 page and the trace waterfall already link with); `j` and
 * `k` move between rows while it is open.
 */
export function SdkEventsTable({
  projectId,
  events,
  pinned,
  openPayload,
  now,
  empty,
  loading = false,
}: {
  projectId: string;
  events: readonly SdkEventView[];
  /** The event a link asked for when it is not in this list (older, or filtered out). */
  pinned: SdkEventView | null;
  /** The payload of the event the URL opened; others are read when they open. */
  openPayload: SdkEventPayload | null;
  /** ISO render time, so relative times agree on server and client. */
  now: string;
  empty: { title: string; description: string; action?: ReactNode };
  /** A filter change is on its way: skeleton rows until it lands. */
  loading?: boolean;
}) {
  const peek = usePeek(SDK_EVENT_PARAM);
  // The Panel keeps showing the last event while it animates closed, a linked one included.
  const [lastId, setLastId] = useState<string | null>(peek.id);
  const at = useMemo(() => new Date(now), [now]);

  // A link names an event by its SDK id or, like the server's lookup, by its row id.
  const names = (event: SdkEventView, id: string) => event.identifier === id || event.key === id;
  const find = (id: string | null) =>
    id === null
      ? undefined
      : (events.find((event) => names(event, id)) ??
        (pinned && names(pinned, id) ? pinned : undefined));
  const openId = peek.id;
  const openIndex = openId === null ? -1 : events.findIndex((event) => names(event, openId));
  // Open: the event the URL names (null when nothing matches it). Closing: the last one, for the exit.
  const shown = (peek.id !== null ? find(peek.id) : find(lastId)) ?? null;
  // Read for the event on show only, keyed by the id the URL names.
  const payload = useSdkEventPayload(projectId, shown ? (peek.id ?? lastId) : null, openPayload);

  function open(event: SdkEventView) {
    setLastId(event.identifier);
    peek.open(event.identifier);
  }

  function step(direction: 1 | -1) {
    const next = events[stepIndex(openIndex, direction, events.length)];
    if (next) open(next);
  }

  const columns: readonly Column<SdkEventView>[] = [
    {
      id: "event",
      header: "Event",
      width: "13rem",
      cell: (event) => (
        <StatusDot tone={event.tone} label={event.label} className="whitespace-nowrap text-fg" />
      ),
    },
    {
      id: "subject",
      header: "About",
      cell: (event) =>
        event.subject ? (
          <span
            title={event.subject}
            className="block max-w-[28rem] min-w-32 truncate text-fg-muted"
          >
            {event.subject}
          </span>
        ) : null,
    },
    {
      id: "source",
      header: "Source",
      width: "11rem",
      cell: (event) => (
        <code
          translate="no"
          title={event.source ?? undefined}
          className="block max-w-40 truncate font-mono text-xs text-fg-muted"
        >
          {event.source ?? "Unknown"}
        </code>
      ),
    },
    {
      id: "duration",
      header: "Duration",
      align: "right",
      width: "6rem",
      cell: (event) => (event.durationMs === null ? null : formatDuration(event.durationMs)),
    },
    {
      id: "time",
      header: "Time",
      align: "right",
      width: "6.5rem",
      cell: (event) => (
        <time
          dateTime={event.at}
          title={formatStamp(event.at)}
          className="whitespace-nowrap text-fg-muted"
        >
          {relativeTime(event.at, at)}
        </time>
      ),
    },
  ];

  const selectedKey = shown && peek.id !== null ? shown.key : null;

  return (
    <>
      <DataTable
        caption="SDK events"
        columns={columns}
        rows={events}
        rowKey={(event) => event.key}
        selectedKey={selectedKey}
        onRowOpen={open}
        loading={loading}
        density="compact"
        empty={
          <EmptyState
            icon={Radio}
            title={empty.title}
            description={empty.description}
            action={empty.action}
          />
        }
      />
      <SdkEventPanel
        open={peek.id !== null}
        onOpenChange={(next) => {
          if (!next) peek.close();
        }}
        event={shown}
        missingId={shown ? null : peek.id}
        payload={payload.state}
        onRetryPayload={payload.retry}
        onPrevious={openIndex >= 0 ? () => step(-1) : undefined}
        onNext={openIndex >= 0 ? () => step(1) : undefined}
      />
    </>
  );
}
