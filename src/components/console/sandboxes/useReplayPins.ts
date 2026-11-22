"use client";

import { useCallback, useEffect, useState } from "react";

/** A pin of the replay session, as `GET /sandboxes/pins` returns it. */
export interface ReplayPin {
  tool: string;
  args: unknown;
  result: unknown;
  isError: boolean;
  createdAt: string;
}

/**
 * The pins of a replay session (RC-1168): listed, added (with the value the
 * reviewer edited) and removed. Pins belong to the replay session, so a run
 * again in that session gives the pinned value to both arms.
 */
export function useReplayPins(api: string, sessionId: string | null) {
  const [pins, setPins] = useState<ReplayPin[]>([]);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((result: ReplayPin[] | null) => {
    if (result) setPins(result);
    setError(result ? null : "Couldn't load the pins.");
  }, []);

  const reload = useCallback(async () => {
    if (sessionId) apply(await fetchPins(api, sessionId));
  }, [api, sessionId, apply]);

  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    void fetchPins(api, sessionId).then((result) => {
      if (live) apply(result);
    });
    return () => {
      live = false;
    };
  }, [api, sessionId, apply]);

  const pin = useCallback(
    async (
      call: { tool: string; args: unknown },
      result: unknown,
      isError: boolean,
    ): Promise<boolean> => {
      if (!sessionId) return false;
      const res = await fetch(`${api}/pins`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, tool: call.tool, args: call.args, result, isError }),
      }).catch(() => null);
      if (res?.status !== 201) return false;
      await reload();
      return true;
    },
    [api, sessionId, reload],
  );

  const unpin = useCallback(
    async (target: Pick<ReplayPin, "tool" | "args">): Promise<boolean> => {
      if (!sessionId) return false;
      const res = await fetch(`${api}/pins`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, tool: target.tool, args: target.args }),
      }).catch(() => null);
      if (!res?.ok) return false;
      await reload();
      return true;
    },
    [api, sessionId, reload],
  );

  // A new replay has no session yet, so it has no pins.
  return { pins: sessionId ? pins : [], error: sessionId ? error : null, pin, unpin, reload };
}

/** The session's pins, or null when they could not be read. */
async function fetchPins(api: string, sessionId: string): Promise<ReplayPin[] | null> {
  const res = await fetch(`${api}/pins?sessionId=${encodeURIComponent(sessionId)}`, {
    cache: "no-store",
  }).catch(() => null);
  const body = res?.ok
    ? ((await res.json().catch(() => null)) as { pins?: ReplayPin[] } | null)
    : null;
  return body?.pins ?? null;
}
