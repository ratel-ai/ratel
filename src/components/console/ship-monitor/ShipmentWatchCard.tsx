"use client";

import { Badge, type Tone } from "@ratel/design-system/badge";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { type StatDelta, StatRow } from "@ratel/design-system/stat-row";
import { Callout, Skeleton } from "@ratel/design-system/states";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { relativeTime } from "@/lib/console/settings/format";
import type { WatchResponseBody } from "@/lib/views/ship-monitor/route";
import type {
  ChangedToolWatch,
  RemovedToolWatch,
  ShipmentWatch,
  WatchStatus,
  WatchTrace,
} from "@/lib/views/ship-monitor/watch";

/**
 * Ship → Monitor: one shipped fix in live traffic. The verdict first, then the
 * runs that use the fix's tools before and after, the changed tools beside
 * their 7 days before, the tools the fix removed (expected: no call) and the
 * newest traces. It reads the watch again every 10 s while it is on screen.
 * `ShipmentWatchCard` is one shipment (the Panel); `ShipmentWatchList` is Ship's newest few.
 */

const REFRESH_MS = 10_000;

const STATUS: Record<WatchStatus, { label: string; tone: Tone }> = {
  healthy: { label: "Healthy", tone: "success" },
  watching: { label: "Watching", tone: "info" },
  regressed: { label: "Regressed", tone: "danger" },
};

export function ShipmentWatchCard({
  projectId,
  shipmentId,
}: {
  projectId: string;
  shipmentId: string;
}) {
  const { watches, failed, loaded } = useLiveWatches(watchUrl(projectId, shipmentId), null);
  const watch = watches[0];
  if (!watch) {
    if (!loaded) return <WatchSkeleton />;
    return failed ? (
      <Callout tone="danger" title="The watch did not load">
        It tries again in a moment.
      </Callout>
    ) : (
      <p className="text-xs text-fg-subtle">This fix names no tools to watch.</p>
    );
  }
  return <WatchBody watch={watch} stale={failed} />;
}

/**
 * The newest shipped fixes on Ship, each in its own card. A shipment recorded
 * while the page is open joins the list on the next read, and the page's
 * table is refreshed with it.
 */
export function ShipmentWatchList({
  projectId,
  initial,
}: {
  projectId: string;
  initial: readonly ShipmentWatch[];
}) {
  const router = useRouter();
  const { watches, failed } = useLiveWatches(watchUrl(projectId, null), initial);
  const ids = watches.map((watch) => watch.shipment.id).join(",");
  const shown = useRef(ids);
  useEffect(() => {
    if (ids === shown.current) return;
    shown.current = ids;
    router.refresh();
  }, [ids, router]);
  if (watches.length === 0) {
    return (
      <p className="text-ui text-fg-muted">
        {failed
          ? "The watch did not load. It tries again in a moment."
          : "No shipped fix names tools to watch yet. A fix marked as shipped shows up here within 10 seconds."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {watches.map((watch) => (
        <article
          key={watch.shipment.id}
          className="rounded-lg border border-line p-4"
          aria-label={`Watch of ${watch.shipment.fixTitle ?? "a shipped fix"}`}
        >
          <WatchBody watch={watch} stale={failed} />
        </article>
      ))}
    </div>
  );
}

function watchUrl(projectId: string, shipmentId: string | null): string {
  const base = `/api/projects/${encodeURIComponent(projectId)}/ship/watch`;
  return shipmentId ? `${base}?shipment=${encodeURIComponent(shipmentId)}` : base;
}

/** The watches at `url`, read now when there is nothing to start from, then every 10 s while the tab is visible. */
function useLiveWatches(url: string, initial: readonly ShipmentWatch[] | null) {
  const [watches, setWatches] = useState<readonly ShipmentWatch[]>(initial ?? []);
  const [loaded, setLoaded] = useState(initial !== null);
  const [failed, setFailed] = useState(false);
  const startsEmpty = initial === null;
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        const body = (await response.json()) as WatchResponseBody;
        if (!alive) return;
        if (body.ok) setWatches(body.watches);
        setFailed(!body.ok);
      } catch {
        if (alive) setFailed(true);
      }
      if (alive) setLoaded(true);
    };
    if (startsEmpty) void read();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [url, startsEmpty]);
  return { watches, failed, loaded };
}

function WatchBody({ watch, stale }: { watch: ShipmentWatch; stale: boolean }) {
  const status = STATUS[watch.verdict.status];
  const checked = new Date(watch.checkedAt);
  const { before, after } = watch.runs;
  return (
    <div
      className="flex flex-col gap-4"
      data-shipment-watch={watch.shipment.id}
      data-verdict={watch.verdict.status}
    >
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          <h3 className="min-w-0 text-ui font-medium text-fg">
            {watch.shipment.fixTitle ?? "Fix shipped"}
          </h3>
        </div>
        <p className="text-xs text-fg-subtle">
          Shipped in {watch.shipment.version}, {relativeTime(watch.shipment.shippedAt, checked)}.
          Checked {checked.toLocaleTimeString()}
          {stale ? ", the last refresh failed" : ""}. Refreshes every 10 seconds.
        </p>
        {watch.verdict.reasons.map((reason) => (
          <p key={reason} className="text-ui text-fg-muted">
            {reason}
          </p>
        ))}
      </header>

      <StatRow
        stats={[
          {
            label: "Runs since the ship",
            value: after.runs,
            hint:
              after.runs < watch.minRuns
                ? `A verdict after ${watch.minRuns}`
                : `${before.runs} in the 7 days before`,
          },
          {
            label: "Tool calls per run",
            value: fixed(after.toolCallsPerRun, 1),
            delta: delta(after.toolCallsPerRun, before.toolCallsPerRun),
            hint: `${fixed(before.toolCallsPerRun, 1)} before`,
          },
          {
            label: "Tokens per run",
            value: thousands(after.tokensPerRun),
            delta: delta(after.tokensPerRun, before.tokensPerRun),
            hint: `${thousands(before.tokensPerRun)} before`,
          },
        ]}
      />
      <p className="text-xs text-fg-subtle">Runs that call {watch.runs.tools.join(" or ")}.</p>

      {watch.changed.length > 0 ? <ChangedTools rows={watch.changed} /> : null}
      {watch.removed.length > 0 ? <RemovedTools rows={watch.removed} /> : null}
      <LatestTraces rows={watch.traces} at={checked} />
    </div>
  );
}

function ChangedTools({ rows }: { rows: readonly ChangedToolWatch[] }) {
  const columns: Column<ChangedToolWatch>[] = [
    {
      id: "tool",
      header: "Changed tool",
      cell: (row) => <code className="text-ui text-fg">{row.toolId}</code>,
    },
    {
      id: "calls",
      header: "Calls since",
      align: "right",
      width: "7rem",
      cell: (row) => <Count value={row.after.calls} />,
    },
    {
      id: "errors",
      header: "Error rate",
      align: "right",
      width: "10rem",
      cell: (row) => (
        <Pair after={percent(row.after.errorRate)} before={percent(row.baseline.errorRate)} />
      ),
    },
    {
      id: "p50",
      header: "p50 latency",
      align: "right",
      width: "11rem",
      cell: (row) => <Pair after={ms(row.after.p50Ms)} before={ms(row.baseline.p50Ms)} />,
    },
  ];
  return (
    <DataTable
      caption="Changed tools since the ship, and the 7 days before"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.toolId}
      density="compact"
    />
  );
}

function RemovedTools({ rows }: { rows: readonly RemovedToolWatch[] }) {
  const columns: Column<RemovedToolWatch>[] = [
    {
      id: "tool",
      header: "Removed tool",
      cell: (row) => <code className="text-ui text-fg">{row.toolId}</code>,
    },
    {
      id: "after",
      header: "Calls since",
      align: "right",
      width: "10rem",
      cell: (row) =>
        row.flagged ? (
          <Badge tone="danger">{row.callsAfter} called</Badge>
        ) : (
          <span className="text-ui text-fg tabular-nums">0, as expected</span>
        ),
    },
    {
      id: "before",
      header: "7 days before",
      align: "right",
      width: "8rem",
      cell: (row) => <Count value={row.baselineCalls} />,
    },
  ];
  return (
    <DataTable
      caption="Removed tools: expected 0 calls since the ship"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.toolId}
      density="compact"
    />
  );
}

function LatestTraces({ rows, at }: { rows: readonly WatchTrace[]; at: Date }) {
  const columns: Column<WatchTrace>[] = [
    {
      id: "trace",
      header: "Latest traces",
      cell: (row) => (
        <Link href={row.href} className="text-ui text-fg underline-offset-2 hover:underline">
          {row.tools.join(", ")}
        </Link>
      ),
    },
    {
      id: "flag",
      header: "Status",
      width: "9rem",
      cell: (row) =>
        row.calledRemoved ? (
          <Badge tone="danger">Removed tool</Badge>
        ) : row.error ? (
          <Badge tone="warning">Error</Badge>
        ) : (
          <span className="text-ui text-fg-muted">OK</span>
        ),
    },
    {
      id: "at",
      header: "When",
      align: "right",
      width: "7rem",
      cell: (row) => (
        <span className="text-ui text-fg-muted tabular-nums">
          {relativeTime(row.startedAt, at)}
        </span>
      ),
    },
  ];
  return (
    <DataTable
      caption="Latest traces that call the fix's tools"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.traceId}
      density="compact"
      empty={
        <p className="p-4 text-ui text-fg-muted">No trace calls these tools since the ship yet.</p>
      }
    />
  );
}

function Pair({ after, before }: { after: string; before: string }) {
  return (
    <span className="text-ui tabular-nums">
      <span className="text-fg">{after}</span> <span className="text-fg-subtle">vs {before}</span>
    </span>
  );
}

function Count({ value }: { value: number }) {
  return <span className="text-ui text-fg tabular-nums">{value.toLocaleString()}</span>;
}

function WatchSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the watch" className="flex flex-col gap-3">
      <Skeleton className="h-5 w-64" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

/** Fewer calls and tokens per run are good. */
function delta(after: number | null, before: number | null): StatDelta | undefined {
  if (after === null || before === null || before === 0) return undefined;
  const change = (after - before) / before;
  const rounded = Math.round(change * 100);
  if (rounded === 0)
    return { value: "0%", direction: "flat", good: null, label: "vs the 7 days before" };
  return {
    value: `${rounded > 0 ? "+" : ""}${rounded}%`,
    direction: rounded > 0 ? "up" : "down",
    good: rounded < 0,
    label: "vs the 7 days before",
  };
}

const fixed = (value: number | null, places: number) =>
  value === null ? "None" : value.toFixed(places);
const thousands = (value: number | null) =>
  value === null
    ? "None"
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}K`
      : String(Math.round(value));
const percent = (value: number | null) =>
  value === null ? "None" : `${(value * 100).toFixed(1)}%`;
const ms = (value: number | null) => (value === null ? "None" : `${Math.round(value)} ms`);
