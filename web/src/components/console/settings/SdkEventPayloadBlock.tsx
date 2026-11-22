"use client";

import { Button } from "@ratel/design-system/button";
import { CodeBlock } from "@ratel/design-system/code";
import { Callout, Skeleton } from "@ratel/design-system/states";
import type { PayloadState } from "@/components/console/settings/use-sdk-event-payload";

/** The payload part of an event's Panel: lines while it loads, the JSON, or a retry. */
export function SdkEventPayloadBlock({
  state,
  onRetry,
}: {
  state: PayloadState;
  onRetry: () => void;
}) {
  if (state.status === "ready") {
    return <CodeBlock caption="Payload" samples={[{ label: "JSON", code: state.payload.json }]} />;
  }
  if (state.status === "error") {
    return (
      <Callout
        tone="danger"
        action={
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
      >
        {state.error}
      </Callout>
    );
  }
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex flex-col gap-2 rounded-lg border border-line p-3"
    >
      <span className="sr-only">Loading the payload…</span>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-3 w-3/5" />
    </div>
  );
}
