"use client";

import { cn } from "@ratel/design-system/cn";
import { Spinner } from "@ratel/design-system/spinner";
import { Tooltip } from "@ratel/design-system/tooltip";
import { useEffect, useState } from "react";
import {
  describeFreshness,
  type AnalysisFreshness as Freshness,
} from "@/lib/views/freshness/model";

/** How often the line asks the server again while the tab is visible. */
const POLL_MS = 30_000;

/**
 * One line at the foot of the sidebar: when the project's analysis last
 * updated, or that it is updating or importing right now (RC-39). Analysis
 * runs in the background and may trail the data by a few minutes; this says
 * so, so the delay reads as normal. Shows nothing until it knows.
 */
export function AnalysisFreshness({
  projectId,
  collapsed,
}: {
  projectId: string;
  collapsed: boolean;
}) {
  const [freshness, setFreshness] = useState<Freshness | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch(`/api/projects/${projectId}/freshness`, { cache: "no-store" });
        if (response.status === 200 && !cancelled)
          setFreshness((await response.json()) as Freshness);
      } catch {
        // Offline or a slow read: keep what the line already shows.
      }
      if (!cancelled) setNow(Date.now());
    };
    void load();
    const timer = window.setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [projectId]);

  const line = freshness ? describeFreshness(freshness, now) : null;
  if (!line) return null;

  const mark =
    line.state === "working" ? (
      <Spinner className="text-fg-subtle" />
    ) : (
      <span aria-hidden className="inline-block size-1.5 shrink-0 rounded-full bg-fg-faint" />
    );

  if (collapsed) {
    return (
      <Tooltip content={line.text} side="right">
        <span role="status" aria-label={line.text} className="flex h-7 items-center justify-center">
          {mark}
        </span>
      </Tooltip>
    );
  }
  return (
    <p
      role="status"
      title={line.title ?? undefined}
      data-analysis-freshness={line.state}
      className={cn("flex items-center gap-2 px-2 pb-1.5 text-xs text-fg-subtle tabular-nums")}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">{mark}</span>
      <span className="min-w-0 truncate">{line.text}</span>
    </p>
  );
}
