"use client";

import { Badge, StatusDot } from "@ratel/design-system/badge";
import { cn } from "@ratel/design-system/cn";
import Link from "next/link";
import { formatStamp, relativeTime } from "@/lib/console/settings/format";
import {
  BASELINE_PILL,
  configPillText,
  groupBySession,
} from "@/lib/views/sandboxes/playground-state";
import { runStatus, type SandboxRunItem, traceHref } from "./types";

/**
 * The left column: the caller's runs of this sandbox, grouped by session, newest
 * first. Each run shows its status, time, changed params and a trace link; a
 * click loads its input and params into the editor.
 */
export function RunList({
  projectId,
  runs,
  loading,
  error,
  productionHash,
  selectedId,
  sessionId,
  now,
  onOpen,
}: {
  projectId: string;
  runs: readonly SandboxRunItem[];
  loading: boolean;
  error: string | null;
  productionHash: string | null;
  selectedId: string | null;
  sessionId: string | null;
  now: Date;
  onOpen: (run: SandboxRunItem) => void;
}) {
  if (error) return <p className="text-ui text-danger">{error}</p>;
  if (loading && runs.length === 0) {
    return (
      <div aria-hidden className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-14 animate-pulse rounded-md bg-hover motion-reduce:animate-none"
          />
        ))}
      </div>
    );
  }
  if (runs.length === 0)
    return (
      <p className="text-ui text-fg-muted">No runs yet. Your runs of this sandbox show here.</p>
    );

  return (
    <div className="flex flex-col gap-4">
      {groupBySession(runs).map((group, index) => (
        <section
          key={group.sessionId ?? `none-${index}`}
          className="flex flex-col gap-1"
          aria-label="Session"
        >
          <h3 className="flex items-center gap-2 px-2 text-xs text-fg-subtle">
            Session
            <code translate="no" className="font-mono">
              {group.sessionId?.slice(0, 8) ?? "none"}
            </code>
            {group.sessionId && group.sessionId === sessionId ? (
              <Badge tone="accent">Current</Badge>
            ) : null}
          </h3>
          <ul className="flex flex-col">
            {group.runs.map((run) => {
              const status = runStatus(run.status);
              const pill = configPillText({
                changed: run.overrides,
                configHash: run.configHash,
                productionHash,
              });
              return (
                <li key={run.id}>
                  <div
                    className={cn(
                      "group flex flex-col gap-1 rounded-md px-2 py-2 transition-[background-color] duration-120 hover:bg-hover",
                      run.id === selectedId && "bg-selected hover:bg-selected",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onOpen(run)}
                      className="flex items-center justify-between gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
                      aria-label={`Load the run from ${formatStamp(run.createdAt)} into the editor`}
                    >
                      <StatusDot tone={status.tone} label={status.label} />
                      <time
                        dateTime={run.createdAt}
                        title={formatStamp(run.createdAt)}
                        className="text-xs text-fg-subtle tabular-nums"
                      >
                        {relativeTime(run.createdAt, now)}
                      </time>
                    </button>
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <span
                        className={cn(
                          "truncate text-xs",
                          pill === BASELINE_PILL ? "text-success" : "text-fg-muted",
                        )}
                        title={pill}
                      >
                        {run.overrides.length > 0 ? run.overrides.join(", ") : pill}
                      </span>
                      {run.traceId ? (
                        <Link
                          href={traceHref(projectId, run.traceId)}
                          className="shrink-0 rounded-sm text-xs text-fg-muted underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                        >
                          Trace
                        </Link>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
