"use client";

import { cn } from "@ratel/design-system/cn";
import { EmptyState } from "@ratel/design-system/states";
import { Orbit } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { AsksPack, type AsksRead } from "@/components/console/intent-map/AsksPack";
import { ToolNetwork } from "@/components/console/intent-map/ToolNetwork";
import type { DashboardClusters } from "@/lib/views/dashboards/clusters";
import { intentsMapHref } from "@/lib/views/dashboards/links";
import { absoluteTime } from "@/lib/views/intents/map/labels";

/** Only the clusters themselves: what is inside one is read on the Intents page. */
const CLUSTERS_ONLY: AsksRead = { status: "ready", trees: new Map() };
/** What zooms or pans the Intents map. A click, a hover and the keys stay. */
const ZOOM_EVENTS = [
  "wheel",
  "gesturestart",
  "gesturechange",
  "pointerdown",
  "mousedown",
  "touchstart",
  "dblclick",
] as const;

/** A part of the stored intent map, with the Intents page's own drawings in a small, still place. */
export function ClustersBody({
  projectId,
  result: { view, model, steps, analyzedAt },
  fill = false,
}: {
  projectId: string;
  result: DashboardClusters;
  /** Take the height of the place it is in. */
  fill?: boolean;
}) {
  const router = useRouter();
  const hostRef = useRef<HTMLDivElement>(null);
  const href = intentsMapHref(projectId);
  const empty = view === "asks" ? model.asks.length === 0 : model.capabilities.length === 0;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || empty) return;
    const still = (event: Event) => event.stopPropagation();
    for (const name of ZOOM_EVENTS) host.addEventListener(name, still, { capture: true });
    return () => {
      for (const name of ZOOM_EVENTS) host.removeEventListener(name, still, { capture: true });
    };
  }, [empty]);

  if (!analyzedAt)
    return (
      <EmptyState
        icon={Orbit}
        title="No intent analysis yet"
        description="The clusters appear after the first analysis of the project's asks."
      />
    );
  return (
    <div className={cn("flex min-w-0 flex-col", fill ? "h-full" : "h-96")}>
      {empty ? (
        <div className="min-h-0 flex-1">
          <EmptyState
            icon={Orbit}
            title="No cluster matches"
            description="Choose other clusters, tools, skills or tasks, or a smaller minimum size."
          />
        </div>
      ) : (
        <div
          ref={hostRef}
          data-clusters={view}
          // The trail and the legend are about what is inside a cluster, which is not drawn here: their room is the drawing's.
          className="[&>[data-asks-pack]>:last-child]:hidden min-h-0 flex-1 overflow-hidden [&_svg]:cursor-default! [&_svg]:touch-auto! [&>[data-asks-pack]]:-mt-11 [&>[data-asks-pack]]:h-[calc(100%+2.75rem)]! [&>*]:h-full [&>*]:min-h-0 [&>*]:border-0 [&_nav]:hidden"
        >
          {view === "asks" ? (
            <AsksPack
              model={model}
              read={CLUSTERS_ONLY}
              focus={null}
              onFocus={() => {}}
              onOpenIntent={() => router.push(href)}
            />
          ) : (
            <ToolNetwork
              model={model}
              steps={steps}
              selectedId={null}
              onOpen={() => router.push(href)}
              onClear={() => {}}
            />
          )}
        </div>
      )}
      <p className="shrink-0 pt-2 text-xs text-fg-subtle">
        Analysis of {absoluteTime(new Date(analyzedAt))}. The time range and the filters of the page
        do not change it.{" "}
        <Link href={href} className="text-fg-muted underline hover:text-fg">
          Open Intents
        </Link>
      </p>
    </div>
  );
}
