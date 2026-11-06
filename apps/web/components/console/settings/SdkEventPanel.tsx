"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { CopyButton } from "@ratel/design-system/code";
import { Panel } from "@ratel/design-system/panel";
import { EmptyState } from "@ratel/design-system/states";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { SdkEventPayloadBlock } from "@/components/console/settings/SdkEventPayloadBlock";
import type { PayloadState } from "@/components/console/settings/use-sdk-event-payload";
import { formatDuration, formatStamp } from "@/lib/console/settings/format";
import { type SdkEventView, sourceStatusNote } from "@/lib/console/settings/sdk-events";

/**
 * One SDK event, inspected without leaving the list (DESIGN.md, Overlays):
 * the plain name up top, then the raw type, ids and values for the developer,
 * then the payload exactly as it arrived, read for this event when it opens.
 */
export function SdkEventPanel({
  open,
  onOpenChange,
  event,
  missingId,
  payload,
  onRetryPayload,
  onPrevious,
  onNext,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The event on show; kept while the panel animates closed. */
  event: SdkEventView | null;
  /** The id from the URL when no event matches it. */
  missingId: string | null;
  payload: PayloadState;
  onRetryPayload: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  if (!event) {
    return (
      <Panel
        open={open}
        onOpenChange={onOpenChange}
        title="Event not found"
        subtitle={missingId ?? undefined}
      >
        <EmptyState
          title="No event with this id"
          description="It may have expired, or it was sent to another project."
        />
      </Panel>
    );
  }

  return (
    <Panel
      open={open}
      onOpenChange={onOpenChange}
      title={event.label}
      subtitle={formatStamp(event.at)}
      onPrevious={onPrevious}
      onNext={onNext}
      actions={
        event.traceHref ? (
          <Link href={event.traceHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Open trace
            <ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
        ) : null
      }
    >
      <div className="flex flex-col gap-5">
        {event.error ? (
          <p role="note" className="rounded-md bg-danger-subtle px-3 py-2 text-ui text-danger">
            {event.error}
          </p>
        ) : null}
        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-ui">
          <Detail label="Type">
            <code translate="no" className="font-mono text-xs text-fg">
              {event.type}
            </code>
          </Detail>
          {event.subject ? <Detail label="About">{event.subject}</Detail> : null}
          <Detail label="Source">
            {event.source ? (
              <span className="inline-flex min-w-0 items-center gap-2">
                <code translate="no" className="truncate font-mono text-xs text-fg">
                  {event.source}
                </code>
                {sourceStatusNote(event.sourceStatus) ? (
                  <span className="shrink-0 text-xs text-fg-subtle">
                    {sourceStatusNote(event.sourceStatus)}
                  </span>
                ) : null}
              </span>
            ) : (
              <Absent />
            )}
          </Detail>
          <Identifier label="Event ID" value={event.ids.event} />
          <Identifier label="Trace ID" value={event.ids.trace} />
          <Identifier label="Span ID" value={event.ids.span} />
          <Identifier label="Invocation ID" value={event.ids.invocation} />
          <Detail label="Received">{formatStamp(event.receivedAt)}</Detail>
          {event.durationMs !== null ? (
            <Detail label="Duration">{formatDuration(event.durationMs)}</Detail>
          ) : null}
          {event.values.hits !== null ? <Detail label="Results">{event.values.hits}</Detail> : null}
          {event.values.topK !== null ? (
            <Detail label="Asked for">{event.values.topK}</Detail>
          ) : null}
          {event.values.inputTokens !== null ? (
            <Detail label="Input tokens">{event.values.inputTokens}</Detail>
          ) : null}
          {event.values.outputTokens !== null ? (
            <Detail label="Output tokens">{event.values.outputTokens}</Detail>
          ) : null}
        </dl>
        <SdkEventPayloadBlock state={payload} onRetry={onRetryPayload} />
      </div>
    </Panel>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="min-w-0 text-fg tabular-nums">{children}</dd>
    </>
  );
}

function Identifier({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <Detail label={label}>
      <span className="flex min-w-0 items-center gap-1">
        <code translate="no" title={value} className="truncate font-mono text-xs text-fg">
          {value}
        </code>
        <CopyButton text={value} label={`Copy ${label.charAt(0).toLowerCase()}${label.slice(1)}`} />
      </span>
    </Detail>
  );
}

function Absent() {
  return <span className="text-fg-subtle">Not reported</span>;
}
