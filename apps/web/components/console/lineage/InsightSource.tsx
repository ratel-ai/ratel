"use client";

import { Skeleton } from "@ratel/design-system/states";
import { useEffect, useState } from "react";
import type { LineageResponseBody } from "@/lib/views/lineage/route";
import type { LineageRef } from "@/lib/views/lineage/types";
import { SourceLink } from "./SourceLink";
import { useStageSpine } from "./stage-spine-context";

type State =
  | { status: "loading" }
  | { status: "ready"; source: LineageRef | null }
  | { status: "error" };

/** One read per insight per page: reopening a panel does not ask again. */
const cache = new Map<string, LineageRef | null>();

export function lineageUrl(projectId: string, kind: string, id: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/lineage?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`;
}

/**
 * "From trace …" (or "From metric …") on an insight's panel, behind
 * `cloud-stage-spine`. The source is read when the panel opens, since naming
 * the run means reading the insight's sampled turns. A failed read shows
 * nothing: the panel is about the insight, not its source.
 */
export function InsightSource({ projectId, signalId }: { projectId: string; signalId: string }) {
  const on = useStageSpine();
  const key = `${projectId}:${signalId}`;
  const [state, setState] = useState<State>(() =>
    cache.has(key) ? { status: "ready", source: cache.get(key) ?? null } : { status: "loading" },
  );
  const [seenKey, setSeenKey] = useState(key);
  if (seenKey !== key) {
    setSeenKey(key);
    setState(
      cache.has(key) ? { status: "ready", source: cache.get(key) ?? null } : { status: "loading" },
    );
  }

  useEffect(() => {
    if (!on || cache.has(key)) return;
    const controller = new AbortController();
    fetch(lineageUrl(projectId, "insight", signalId), {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        const body = (await response.json()) as LineageResponseBody;
        if (!response.ok || !body.ok || !("source" in body)) {
          setState({ status: "error" });
          return;
        }
        cache.set(key, body.source);
        setState({ status: "ready", source: body.source });
      })
      .catch((error: unknown) => {
        if ((error as { name?: string })?.name !== "AbortError") setState({ status: "error" });
      });
    return () => controller.abort();
  }, [on, key, projectId, signalId]);

  if (!on || state.status === "error") return null;
  if (state.status === "loading") return <Skeleton className="h-6 w-56" />;
  return <SourceLink source={state.source} projectId={projectId} />;
}
