"use client";

import { useCallback, useEffect, useState } from "react";
import { readSdkEventPayloadAction } from "@/app/(console)/project/[projectId]/settings/developer/actions";
import type { SdkEventPayload } from "@/lib/console/settings/sdk-events";

export type PayloadState =
  | { status: "loading" }
  | { status: "ready"; payload: SdkEventPayload }
  | { status: "error"; error: string };

const FAILED = "Couldn't load the payload. Try again in a moment.";

/**
 * The open event's payload, read when its Panel opens rather than shipped with
 * the list. Results are kept per event id for the page's life, so stepping
 * back with `k` does not read again; a failure can be retried.
 */
export function useSdkEventPayload(
  projectId: string,
  identifier: string | null,
  initial: SdkEventPayload | null,
) {
  const [results, setResults] = useState<
    ReadonlyMap<string, Exclude<PayloadState, { status: "loading" }>>
  >(() => new Map(initial ? [[initial.identifier, { status: "ready", payload: initial }]] : []));
  const current = identifier ? results.get(identifier) : undefined;

  useEffect(() => {
    if (!identifier || current) return;
    let cancelled = false;
    const settle = (state: Exclude<PayloadState, { status: "loading" }>) => {
      if (!cancelled) setResults((previous) => new Map(previous).set(identifier, state));
    };
    readSdkEventPayloadAction(projectId, identifier).then(
      (result) =>
        settle(
          result.ok
            ? { status: "ready", payload: result.payload }
            : { status: "error", error: result.error },
        ),
      (error: unknown) => {
        // The action never reached its own logging (offline, a deploy): say so here.
        console.error("[sdk events] payload read failed:", error);
        settle({ status: "error", error: FAILED });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, identifier, current]);

  const retry = useCallback(() => {
    if (!identifier) return;
    setResults((previous) => {
      const next = new Map(previous);
      next.delete(identifier);
      return next;
    });
  }, [identifier]);

  const state: PayloadState = current ?? { status: "loading" };
  return { state, retry };
}
